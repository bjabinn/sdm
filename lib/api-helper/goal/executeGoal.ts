/*
 * Copyright © 2019 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    configurationValue,
    failure,
    GitProject,
    HandlerContext,
    HandlerResult,
    logger,
    RemoteRepoRef,
    Success,
} from "@atomist/automation-client";
import * as _ from "lodash";
import * as path from "path";
import { AddressChannels } from "../../api/context/addressChannels";
import {
    ExecuteGoalResult,
    isFailure,
} from "../../api/goal/ExecuteGoalResult";
import { Goal } from "../../api/goal/Goal";
import {
    ExecuteGoal,
    GoalInvocation,
    GoalProjectListenerEvent,
    GoalProjectListenerRegistration,
} from "../../api/goal/GoalInvocation";
import { ReportProgress } from "../../api/goal/progress/ReportProgress";
import { SdmGoalEvent } from "../../api/goal/SdmGoalEvent";
import { GoalImplementation } from "../../api/goal/support/GoalImplementationMapper";
import {
    GoalExecutionListener,
    GoalExecutionListenerInvocation,
} from "../../api/listener/GoalStatusListener";
import { SoftwareDeliveryMachineConfiguration } from "../../api/machine/SoftwareDeliveryMachineOptions";
import { AnyPush } from "../../api/mapping/support/commonPushTests";
import { InterpretLog } from "../../spi/log/InterpretedLog";
import { ProgressLog } from "../../spi/log/ProgressLog";
import {
    isLazyProjectLoader,
    LazyProject,
} from "../../spi/project/LazyProjectLoader";
import { ProjectLoader } from "../../spi/project/ProjectLoader";
import { SdmGoalState } from "../../typings/types";
import { format } from "../log/format";
import { WriteToAllProgressLog } from "../log/WriteToAllProgressLog";
import { spawnLog } from "../misc/child_process";
import { toToken } from "../misc/credentials/toToken";
import { reportFailureInterpretation } from "../misc/reportFailureInterpretation";
import { serializeResult } from "../misc/result";
import { ProjectListenerInvokingProjectLoader } from "../project/ProjectListenerInvokingProjectLoader";
import { mockGoalExecutor } from "./mock";
import {
    descriptionFromState,
    updateGoal,
} from "./storeGoals";

class GoalExecutionError extends Error {
    public readonly where: string;
    public readonly result?: ExecuteGoalResult;
    public readonly cause?: Error;

    constructor(params: { where: string, result?: ExecuteGoalResult, cause?: Error }) {
        super("Failure in " + params.where);
        this.where = params.where;
        this.result = params.result;
        this.cause = params.cause;
    }

    get description(): string {
        const resultDescription = this.result ? `Result code ${this.result.code} ${this.result.message}` : "";
        const causeDescription = this.cause ? `Caused by: ${this.cause.message}` : "";
        return `Failure in ${this.where}: ${resultDescription} ${causeDescription}`;
    }
}

/**
 * Central function to execute a goal with progress logging
 */
export async function executeGoal(rules: { projectLoader: ProjectLoader, goalExecutionListeners: GoalExecutionListener[] },
                                  implementation: GoalImplementation,
                                  gi: GoalInvocation): Promise<ExecuteGoalResult> {
    const { goal, goalEvent, addressChannels, progressLog, id, context, credentials, configuration, preferences } = gi;
    const { progressReporter, logInterpreter, projectListeners } = implementation;
    const implementationName = goalEvent.fulfillment.name;

    if (!!progressReporter) {
        gi.progressLog = new WriteToAllProgressLog(
            goalEvent.name,
            gi.progressLog,
            new ProgressReportingProgressLog(progressReporter, goalEvent, gi.context),
        );
    }

    logger.info(`Running ${goalEvent.uniqueName} on ${goalEvent.sha}`);

    async function notifyGoalExecutionListeners(sge: SdmGoalEvent, result?: ExecuteGoalResult, error?: Error): Promise<void> {
        const inProcessGoalExecutionListenerInvocation: GoalExecutionListenerInvocation = {
            id,
            context,
            addressChannels,
            configuration,
            preferences,
            credentials,
            goal,
            goalEvent: sge,
            error,
            result,
        };
        await Promise.all(rules.goalExecutionListeners.map(gel => {
            try {
                return gel(inProcessGoalExecutionListenerInvocation);
            } catch (e) {
                logger.warn(`GoalExecutionListener failed: ${e.message}`);
                logger.debug(e);
                return undefined;
            }
        }));
    }

    const inProcessGoalEvent = await markGoalInProcess({
        ctx: context,
        goalEvent,
        goal,
        progressLogUrl: progressLog.url,
    });
    await notifyGoalExecutionListeners(inProcessGoalEvent);

    try {

        const goalInvocation = prepareGoalInvocation(gi, projectListeners);

        // execute pre hook
        let result: ExecuteGoalResult = (await executeHook(rules, goalInvocation, inProcessGoalEvent, "pre") || Success);
        if (isFailure(result)) {
            throw new GoalExecutionError({ where: "executing pre-goal hook", result });
        }
        // execute the actual goal
        const goalResult: ExecuteGoalResult = (await prepareGoalExecutor(implementation, inProcessGoalEvent, configuration)(goalInvocation)
            .catch(async err => {
                throw new GoalExecutionError({ where: "executing goal", cause: err });
            })) || Success;
        if (isFailure(goalResult)) {
            throw new GoalExecutionError({ where: "executing goal", result: goalResult });
        }

        // execute post hook
        const hookResult: ExecuteGoalResult =
            (await executeHook(rules, goalInvocation, inProcessGoalEvent, "post")) || Success;
        if (isFailure(hookResult)) {
            throw new GoalExecutionError({ where: "executing post-goal hooks", result: hookResult });
        }

        result = {
            ...result,
            ...goalResult,
            ...hookResult,
        };

        await notifyGoalExecutionListeners({
            ...inProcessGoalEvent,
            state: SdmGoalState.success,
        }, result);

        logger.info("ExecuteGoal: result of %s: %j", implementationName, result);
        await markStatus({ context, goalEvent, goal, result, progressLogUrl: progressLog.url });
        return Success;
    } catch (err) {
        logger.warn("Error executing %s on %s: %s", implementationName, goalEvent.sha, err.message);
        const result = { code: 1, ...(err.result ? err.result : {}) };
        await notifyGoalExecutionListeners({
            ...inProcessGoalEvent,
            state: SdmGoalState.failure,
        }, result, err);
        await reportGoalError({
            goal, implementationName, addressChannels, progressLog, id, logInterpreter,
        }, err);
        await markStatus({
            context,
            goalEvent,
            goal,
            result,
            error: err,
            progressLogUrl: progressLog.url,
        });
        return failure(err);
    }
}

export async function executeHook(rules: { projectLoader: ProjectLoader },
                                  goalInvocation: GoalInvocation,
                                  sdmGoal: SdmGoalEvent,
                                  stage: "post" | "pre"): Promise<HandlerResult> {
    const hook = goalToHookFile(sdmGoal, stage);

    // Check configuration to see if hooks should be skipped
    if (!configurationValue<boolean>("sdm.goal.hooks", true)) {
        goalInvocation.progressLog.write("/--");
        goalInvocation.progressLog.write(`Invoking goal hook: ${hook}`);
        goalInvocation.progressLog.write(`Result: skipped (hooks disabled in configuration)`);
        goalInvocation.progressLog.write("\\--");
        await goalInvocation.progressLog.flush();
        return Success;
    }

    const { projectLoader } = rules;
    const { credentials, id, context, progressLog } = goalInvocation;
    return projectLoader.doWithProject({
        credentials,
        id,
        context,
        readOnly: true,
        cloneOptions: { detachHead: true },
    }, async p => {
        progressLog.write("/--");
        progressLog.write(`Invoking goal hook: ${hook}`);

        if (await p.hasFile(path.join(".atomist", "hooks", hook))) {

            const opts = {
                cwd: path.join(p.baseDir, ".atomist", "hooks"),
                env: {
                    ...process.env,
                    GITHUB_TOKEN: toToken(credentials),
                    ATOMIST_WORKSPACE: context.workspaceId,
                    ATOMIST_CORRELATION_ID: context.correlationId,
                    ATOMIST_REPO: sdmGoal.push.repo.name,
                    ATOMIST_OWNER: sdmGoal.push.repo.owner,
                },
                log: progressLog,
            };

            const cmd = path.join(p.baseDir, ".atomist", "hooks", hook);
            let result: HandlerResult = await spawnLog(cmd, [], opts);
            if (!result) {
                result = Success;
            }

            progressLog.write(`Result: ${serializeResult(result)}`);
            progressLog.write("\\--");
            await progressLog.flush();
            return result;
        } else {
            progressLog.write(`Result: skipped (not provided)`);
            progressLog.write("\\--");
            await progressLog.flush();
            return Success;
        }
    });
}

function goalToHookFile(sdmGoal: SdmGoalEvent,
                        prefix: string): string {
    return `${prefix}-${sdmGoal.environment.toLocaleLowerCase().slice(2)}-${
        sdmGoal.name.toLocaleLowerCase().replace(" ", "_")}`;
}

export function markStatus(parameters: {
                                context: HandlerContext,
                                goalEvent: SdmGoalEvent,
                                goal: Goal,
                                result: ExecuteGoalResult,
                                error?: Error,
                                progressLogUrl: string,
                            }): Promise<void> {
    const { context, goalEvent, goal, result, error, progressLogUrl } = parameters;

    /* tslint:disable:deprecation */
    let newState = SdmGoalState.success;
    if (result.state) {
        newState = result.state;
    } else if (result.requireApproval) {
        newState = SdmGoalState.waiting_for_approval;
    } else if (result.code !== 0) {
        newState = SdmGoalState.failure;
    } else if (goal.definition.approvalRequired) {
        newState = SdmGoalState.waiting_for_approval;
    }

    // Needed for backwards compatibility
    const externalUrls: Array<{ label?: string, url: string }> = result.externalUrls || [];
    if (result.targetUrls) {
        externalUrls.push(...result.targetUrls);
    }
    if (result.targetUrl) {
        externalUrls.push({ label: "Link", url: result.targetUrl });
    }
    /* tslint:enable:deprecation */

    return updateGoal(
        context,
        goalEvent,
        {
            url: progressLogUrl,
            externalUrls,
            state: newState,
            phase: result.phase ? result.phase : goalEvent.phase,
            description: result.description ? result.description : descriptionFromState(goal, newState),
            error,
            data: result.data ? result.data : goalEvent.data,
        });
}

async function markGoalInProcess(parameters: {ctx: HandlerContext,
                                    goalEvent: SdmGoalEvent,
                                    goal: Goal,
                                    progressLogUrl: string,
                                }): Promise<SdmGoalEvent> {
    const { ctx, goalEvent, goal, progressLogUrl } = parameters;
    goalEvent.state = SdmGoalState.in_process;
    goalEvent.description = goal.inProcessDescription;
    goalEvent.url = progressLogUrl;
    try {
        await updateGoal(ctx,
            goalEvent,
            {
                url: progressLogUrl,
                description: goal.inProcessDescription,
                state: SdmGoalState.in_process,
            });
    } catch (err) {
        logger.warn("Failed to update %s goal to tell people we are inProcess on it: \n%s", goal.name, err.stack);
    }
    return goalEvent;
}

/**
 * Report an error executing a goal and present a retry button
 * @return {Promise<void>}
 */
async function reportGoalError(parameters: {
                                   goal: Goal,
                                   implementationName: string,
                                   addressChannels: AddressChannels,
                                   progressLog: ProgressLog,
                                   id: RemoteRepoRef,
                                   logInterpreter: InterpretLog,
                               },
                               err: GoalExecutionError): Promise<void> {
    const { implementationName, addressChannels, progressLog, id, logInterpreter } = parameters;

    if (err.cause) {
        logger.warn(err.cause.stack);
        progressLog.write(err.cause.stack);
    } else if (err.result && (err.result as any).error) {
        logger.warn((err.result as any).error.stack);
        progressLog.write((err.result as any).error.stack);
    } else {
        logger.warn(err.stack);
    }

    progressLog.write("Error: " + (err.description || err.message) + "\n");

    const interpretation = logInterpreter(progressLog.log);
    // The executor might have information about the failure; report it in the channels
    if (interpretation) {
        if (!interpretation.doNotReportToUser) {
            await reportFailureInterpretation(implementationName, interpretation,
                { url: progressLog.url, log: progressLog.log },
                id, addressChannels);
        }
    }
}

export function prepareGoalExecutor(gi: GoalImplementation,
                                    sdmGoal: SdmGoalEvent,
                                    configuration: SoftwareDeliveryMachineConfiguration): ExecuteGoal {
    const mge = mockGoalExecutor(gi.goal, sdmGoal, configuration);
    if (mge) {
        return mge;
    } else {
        return gi.goalExecutor;
    }
}

export function prepareGoalInvocation(gi: GoalInvocation,
                                      listeners: GoalProjectListenerRegistration | GoalProjectListenerRegistration[]): GoalInvocation {

    let hs: GoalProjectListenerRegistration[] =
        listeners ? (Array.isArray(listeners) ? listeners : [listeners]) : [] as GoalProjectListenerRegistration[];

    if (isLazyProjectLoader(gi.configuration.sdm.projectLoader)) {
        // Register the materializing listener for LazyProject instances of those need to
        // get materialized before using in goal implementations
        const projectMaterializer = {
            name: "clone project",
            pushTest: AnyPush,
            events: [GoalProjectListenerEvent.before],
            listener: async (p: GitProject & LazyProject) => {
                if (!p.materialized()) {
                    // Trigger project materialization
                    await p.materialize();
                }
                return { code: 0 };
            },
        };
        hs = [projectMaterializer, ...hs];
    }

    if (hs.length === 0) {
        return gi;
    }

    const configuration = _.cloneDeep(gi.configuration);
    configuration.sdm.projectLoader = new ProjectListenerInvokingProjectLoader(gi, hs);

    const newGi: GoalInvocation = {
        ...gi,
        configuration,
    };

    return newGi;
}

/**
 * ProgressLog implementation that uses the configured ReportProgress
 * instance to report goal execution updates.
 */
class ProgressReportingProgressLog implements ProgressLog {

    public log: string;
    public readonly name: string;
    public url: string;

    constructor(private readonly progressReporter: ReportProgress,
                private readonly sdmGoal: SdmGoalEvent,
                private readonly context: HandlerContext) {
        this.name = sdmGoal.name;
    }

    public async close(): Promise<void> {
        return;
    }

    public async flush(): Promise<void> {
        return;
    }

    public async isAvailable(): Promise<boolean> {
        return true;
    }

    public write(msg: string, ...args: string[]): void {
        const progress = this.progressReporter(format(msg, ...args), this.sdmGoal);
        if (progress && progress.phase) {
            if (this.sdmGoal.phase !== progress.phase) {
                this.sdmGoal.phase = progress.phase;
                updateGoal(
                    this.context,
                    this.sdmGoal,
                    {
                        state: this.sdmGoal.state,
                        phase: progress.phase,
                        description: this.sdmGoal.description,
                        url: this.sdmGoal.url,
                    }).then(() => {
                    // Intentionally empty
                })
                    .catch(err => {
                        logger.warn(`Error occurred reporting progress: %s`, err.message);
                    });
            }
        }
    }
}

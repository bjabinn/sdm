/*
 * Copyright © 2017 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { GraphQL, Secret, Secrets } from "@atomist/automation-client";
import {
    EventFired,
    EventHandler,
    HandleEvent,
    HandlerContext,
    HandlerResult,
    Success,
} from "@atomist/automation-client/Handlers";
import { OnRepoCreation } from "../../../typings/types";
import { SdmListener } from "../delivery/Listener";
import { GitHubRepoRef } from "@atomist/automation-client/operations/common/GitHubRepoRef";

/**
 * A new repo has been created. We don't know if it has code.
 */
@EventHandler("On repo creation",
    GraphQL.subscriptionFromFile("graphql/subscription/OnRepoCreation.graphql"))
export class ActOnRepoCreation implements HandleEvent<OnRepoCreation.Subscription> {

    @Secret(Secrets.OrgToken)
    private githubToken: string;

    constructor(private newRepoAction: SdmListener<OnRepoCreation.Repo>) {
    }

    public async handle(event: EventFired<OnRepoCreation.Subscription>, context: HandlerContext, params: this): Promise<HandlerResult> {
        const repo: OnRepoCreation.Repo = event.data.Repo[0];
        const id = new GitHubRepoRef(repo.owner, repo.name);
        await this.newRepoAction.apply({
            id,
            context,
            data: repo,
            credentials: {token: params.githubToken},
        });
        return Success;
    }
}

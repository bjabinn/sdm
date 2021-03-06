/*
 * Copyright © 2020 Atomist, Inc.
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

import { HandlerContext } from "@atomist/automation-client/lib/HandlerContext";
import { ProjectOperationCredentials } from "@atomist/automation-client/lib/operations/common/ProjectOperationCredentials";
import { RemoteRepoRef } from "@atomist/automation-client/lib/operations/common/RepoId";
import { GitProject } from "@atomist/automation-client/lib/project/git/GitProject";
import { CloneOptions } from "@atomist/automation-client/lib/spi/clone/DirectoryManager";

/**
 * Operation on loaded project
 */
export type WithLoadedProject<T = any> = (p: GitProject) => Promise<T>;

export interface ProjectLoadingParameters {
    credentials: ProjectOperationCredentials;
    id: RemoteRepoRef;
    cloneOptions?: CloneOptions;
    context?: HandlerContext;

    /** Return true to get optimized behavior for read only */
    readOnly: boolean;

    /**
     * Explicitly configured target clone dir
     */
    cloneDir?: string;
}

/**
 * Common interface for project loading that allows caching etc.
 */
export interface ProjectLoader {
    /**
     * Perform an action with the given project
     * @param {ProjectLoadingParameters} params
     * @param {WithLoadedProject<T>} action
     */
    doWithProject<T>(params: ProjectLoadingParameters, action: WithLoadedProject<T>): Promise<T>;
}

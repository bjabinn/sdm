/*
 * Copyright © 2018 Atomist, Inc.
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

import { ProgressLogFactory } from "..";
import { ProjectLoader } from "../common/repo/ProjectLoader";
import { CredentialsResolver } from "../handlers/common/CredentialsResolver";
import { ArtifactStore } from "../spi/artifact/ArtifactStore";

/**
 * Infrastructure options for a SoftwareDeliveryMachine
 */
export interface SoftwareDeliveryMachineOptions {

    artifactStore: ArtifactStore;
    projectLoader: ProjectLoader;
    logFactory: ProgressLogFactory;

    /**
     * Strategy for resolving credentials from a handler invocation
     */
    credentialsResolver: CredentialsResolver;
}

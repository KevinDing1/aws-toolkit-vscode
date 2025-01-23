/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { docScheme, featureName, Mode } from '../constants'
import { DeletedFileInfo, Interaction, NewFileInfo, SessionState, SessionStateConfig } from '../types'
import { PrepareCodeGenState } from './sessionState'
import { telemetry } from '../../shared/telemetry/telemetry'
import { extensionVersion, fs, getLogger, globals } from '../../shared'
import { AuthUtil } from '../../codewhisperer/util/authUtil'
import { SessionConfig } from '../../amazonq/commons/session/sessionConfigFactory'
import { ReferenceLogViewProvider } from '../../codewhisperer'
import path from 'path'
import { FeatureDevClient } from '../../amazonqFeatureDev/client/featureDev'
import { TelemetryHelper } from '../../amazonqFeatureDev/util/telemetryHelper'
import { ConversationNotStartedState } from '../../amazonqFeatureDev/session/sessionState'
import { logWithConversationId } from '../../amazonqFeatureDev/userFacingText'
import { ConversationIdNotFoundError } from '../../amazonqFeatureDev/errors'
import { referenceLogText } from '../../amazonqFeatureDev/constants'
import {
    DocInteractionType,
    DocV2AcceptanceEvent,
    DocV2GenerationEvent,
    SendTelemetryEventRequest,
} from '../../codewhisperer/client/codewhispereruserclient'
import { getClientId, getOperatingSystem, getOptOutPreference } from '../../shared/telemetry/util'
import { DocMessenger } from '../messenger'
import { computeDiff } from '../../amazonq/commons/diff'

export class Session {
    private _state?: SessionState | Omit<SessionState, 'uploadId'>
    private task: string = ''
    private proxyClient: FeatureDevClient
    private _conversationId?: string
    private preloaderFinished = false
    private _latestMessage: string = ''
    private _telemetry: TelemetryHelper

    // Used to keep track of whether or not the current session is currently authenticating/needs authenticating
    public isAuthenticating: boolean
    private _reportedDocChanges: string | undefined = undefined

    constructor(
        public readonly config: SessionConfig,
        private messenger: DocMessenger,
        public readonly tabID: string,
        initialState: Omit<SessionState, 'uploadId'> = new ConversationNotStartedState(tabID),
        proxyClient: FeatureDevClient = new FeatureDevClient()
    ) {
        this._state = initialState
        this.proxyClient = proxyClient

        this._telemetry = new TelemetryHelper()
        this.isAuthenticating = false
    }

    /**
     * Preload any events that have to run before a chat message can be sent
     */
    async preloader(msg: string) {
        if (!this.preloaderFinished) {
            await this.setupConversation(msg)
            this.preloaderFinished = true
        }
    }

    get state() {
        if (!this._state) {
            throw new Error("State should be initialized before it's read")
        }
        return this._state
    }

    /**
     * setupConversation
     *
     * Starts a conversation with the backend and uploads the repo for the LLMs to be able to use it.
     */
    private async setupConversation(msg: string) {
        // Store the initial message when setting up the conversation so that if it fails we can retry with this message
        this._latestMessage = msg

        await telemetry.amazonq_startConversationInvoke.run(async (span) => {
            this._conversationId = await this.proxyClient.createConversation()
            getLogger().info(logWithConversationId(this.conversationId))

            span.record({ amazonqConversationId: this._conversationId, credentialStartUrl: AuthUtil.instance.startUrl })
        })

        this._state = new PrepareCodeGenState(
            {
                ...this.getSessionStateConfig(),
                conversationId: this.conversationId,
                uploadId: '',
                currentCodeGenerationId: undefined,
            },
            [],
            [],
            [],
            this.tabID,
            0
        )
    }

    private getSessionStateConfig(): Omit<SessionStateConfig, 'uploadId'> {
        return {
            workspaceRoots: this.config.workspaceRoots,
            workspaceFolders: this.config.workspaceFolders,
            proxyClient: this.proxyClient,
            conversationId: this.conversationId,
        }
    }

    async send(msg: string, mode: Mode, folderPath?: string): Promise<Interaction> {
        // When the task/"thing to do" hasn't been set yet, we want it to be the incoming message
        if (this.task === '' && msg) {
            this.task = msg
        }

        this._latestMessage = msg

        return this.nextInteraction(msg, mode, folderPath)
    }
    private async nextInteraction(msg: string, mode: Mode, folderPath?: string) {
        const resp = await this.state.interact({
            task: this.task,
            msg,
            fs: this.config.fs,
            mode: mode,
            folderPath: folderPath,
            messenger: this.messenger,
            telemetry: this.telemetry,
            tokenSource: this.state.tokenSource,
            uploadHistory: this.state.uploadHistory,
        })

        if (resp.nextState) {
            if (!this.state?.tokenSource?.token.isCancellationRequested) {
                this.state?.tokenSource?.cancel()
            }

            // Move to the next state
            this._state = resp.nextState
        }

        return resp.interaction
    }

    public async updateFilesPaths(
        tabID: string,
        filePaths: NewFileInfo[],
        deletedFiles: DeletedFileInfo[],
        messageId: string,
        disableFileActions: boolean
    ) {
        this.messenger.updateFileComponent(tabID, filePaths, deletedFiles, messageId, disableFileActions)
    }

    public async insertChanges() {
        for (const filePath of this.state.filePaths?.filter((i) => !i.rejected) ?? []) {
            const absolutePath = path.join(filePath.workspaceFolder.uri.fsPath, filePath.relativePath)

            const uri = filePath.virtualMemoryUri
            const content = await this.config.fs.readFile(uri)
            const decodedContent = new TextDecoder().decode(content)

            await fs.mkdir(path.dirname(absolutePath))
            await fs.writeFile(absolutePath, decodedContent)
        }

        for (const filePath of this.state.deletedFiles?.filter((i) => !i.rejected) ?? []) {
            const absolutePath = path.join(filePath.workspaceFolder.uri.fsPath, filePath.relativePath)
            await fs.delete(absolutePath)
        }

        for (const ref of this.state.references ?? []) {
            ReferenceLogViewProvider.instance.addReferenceLog(referenceLogText(ref))
        }
    }

    public async countGeneratedContent(interactionType?: DocInteractionType) {
        let totalGeneratedChars = 0
        let totalGeneratedLines = 0
        let totalGeneratedFiles = 0
        const filePaths = this.state.filePaths ?? []

        for (const filePath of filePaths) {
            if (interactionType === 'GENERATE_README') {
                if (this._reportedDocChanges) {
                    const { charsAdded, linesAdded } = await this.computeFilePathDiff(
                        filePath,
                        this._reportedDocChanges
                    )
                    totalGeneratedChars += charsAdded
                    totalGeneratedLines += linesAdded
                } else {
                    const fileContent = filePath.fileContent
                    totalGeneratedChars += fileContent.length
                    totalGeneratedLines += fileContent.split('\n').length
                }
            } else {
                const { charsAdded, linesAdded } = await this.computeFilePathDiff(filePath, this._reportedDocChanges)
                totalGeneratedChars += charsAdded
                totalGeneratedLines += linesAdded
            }
            this._reportedDocChanges = filePath.fileContent
            totalGeneratedFiles += 1
        }
        return {
            totalGeneratedChars,
            totalGeneratedLines,
            totalGeneratedFiles,
        }
    }

    public async countAddedContent(interactionType?: DocInteractionType) {
        let totalAddedChars = 0
        let totalAddedLines = 0
        let totalAddedFiles = 0
        const newFilePaths =
            this.state.filePaths?.filter((filePath) => !filePath.rejected && !filePath.changeApplied) ?? []

        for (const filePath of newFilePaths) {
            if (interactionType === 'GENERATE_README') {
                const fileContent = filePath.fileContent
                totalAddedChars += fileContent.length
                totalAddedLines += fileContent.split('\n').length
            } else {
                const { charsAdded, linesAdded } = await this.computeFilePathDiff(filePath)
                totalAddedChars += charsAdded
                totalAddedLines += linesAdded
            }
            totalAddedFiles += 1
        }
        return {
            totalAddedChars,
            totalAddedLines,
            totalAddedFiles,
        }
    }

    public async computeFilePathDiff(filePath: NewFileInfo, reportedChanges?: string) {
        const leftPath = `${filePath.workspaceFolder.uri.fsPath}/${filePath.relativePath}`
        const rightPath = filePath.virtualMemoryUri.path
        const diff = await computeDiff(leftPath, rightPath, this.tabID, docScheme, reportedChanges)
        return { leftPath, rightPath, ...diff }
    }

    public async sendDocGenerationTelemetryEvent(docV2GenerationEvent: DocV2GenerationEvent) {
        const client = await this.proxyClient.getClient()
        try {
            const params: SendTelemetryEventRequest = {
                telemetryEvent: {
                    docV2GenerationEvent,
                },
                optOutPreference: getOptOutPreference(),
                userContext: {
                    ideCategory: 'VSCODE',
                    operatingSystem: getOperatingSystem(),
                    product: 'DocGeneration', // Should be the same as in JetBrains
                    clientId: getClientId(globals.globalState),
                    ideVersion: extensionVersion,
                },
            }
            // const response = await client.sendTelemetryEvent(params).promise()
            getLogger().debug(
                `${featureName}: successfully sent docV2GenerationEvent: ConversationId: ${docV2GenerationEvent.conversationId} RequestId: ${response.$response.requestId}`
            )
        } catch (e) {
            getLogger().error(
                `${featureName}: failed to send doc generation telemetry: ${(e as Error).name}: ${
                    (e as Error).message
                } RequestId: ${(e as any).requestId}`
            )
        }
    }

    public async sendDocAcceptanceTelemetryEvent(docV2AcceptanceEvent: DocV2AcceptanceEvent) {
        const client = await this.proxyClient.getClient()
        try {
            const params: SendTelemetryEventRequest = {
                telemetryEvent: {
                    docV2AcceptanceEvent,
                },
                optOutPreference: getOptOutPreference(),
                userContext: {
                    ideCategory: 'VSCODE',
                    operatingSystem: getOperatingSystem(),
                    product: 'DocGeneration', // Should be the same as in JetBrains
                    clientId: getClientId(globals.globalState),
                    ideVersion: extensionVersion,
                },
            }
            // const response = await client.sendTelemetryEvent(params).promise()
            getLogger().debug(
                `${featureName}: successfully sent docV2AcceptanceEvent: ConversationId: ${docV2AcceptanceEvent.conversationId} RequestId: ${response.$response.requestId}`
            )
        } catch (e) {
            getLogger().error(
                `${featureName}: failed to send doc generation telemetry: ${(e as Error).name}: ${
                    (e as Error).message
                } RequestId: ${(e as any).requestId}`
            )
        }
    }

    get currentCodeGenerationId() {
        return this.state.currentCodeGenerationId
    }

    get uploadId() {
        if (!('uploadId' in this.state)) {
            throw new Error("UploadId has to be initialized before it's read")
        }
        return this.state.uploadId
    }

    get conversationId() {
        if (!this._conversationId) {
            throw new ConversationIdNotFoundError()
        }
        return this._conversationId
    }

    // Used for cases where it is not needed to have conversationId
    get conversationIdUnsafe() {
        return this._conversationId
    }

    get latestMessage() {
        return this._latestMessage
    }

    get telemetry() {
        return this._telemetry
    }
}

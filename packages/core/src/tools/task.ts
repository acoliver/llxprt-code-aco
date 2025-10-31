/**
 * @license
 * Copyright 2025 Vybestack LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import {
  SubagentOrchestrator,
  type SubagentLaunchRequest,
} from '../core/subagentOrchestrator.js';
import {
  ContextState,
  SubagentTerminateMode,
  type OutputObject,
  type RunConfig,
} from '../core/subagent.js';
import type { SubagentManager } from '../config/subagentManager.js';
import type { ProfileManager } from '../config/profileManager.js';
import { ToolErrorType } from './tool-error.js';
import { DEFAULT_AGENT_ID } from '../core/turn.js';
import type { ToolRegistry } from './tool-registry.js';
import { DebugLogger } from '../debug/DebugLogger.js';

const taskLogger = new DebugLogger('llxprt:task');

export interface TaskToolParams {
  subagent_name?: string;
  subagentName?: string;
  goal_prompt?: string;
  goalPrompt?: string;
  behaviour_prompts?: string[];
  behavior_prompts?: string[];
  behaviourPrompts?: string[];
  behaviorPrompts?: string[];
  run_limits?: Partial<RunLimits>;
  runLimits?: Partial<RunLimits>;
  tool_whitelist?: string[];
  toolWhitelist?: string[];
  output_spec?: Record<string, string>;
  outputSpec?: Record<string, string>;
  context?: Record<string, unknown>;
  context_vars?: Record<string, unknown>;
  contextVars?: Record<string, unknown>;
}

interface RunLimits {
  max_time_minutes: number;
  max_turns?: number;
  interactive?: boolean;
}

interface TaskToolInvocationParams {
  subagentName: string;
  goalPrompt: string;
  behaviourPrompts: string[];
  runConfig?: Partial<RunLimits>;
  toolWhitelist?: string[];
  outputSpec?: Record<string, string>;
  context: Record<string, unknown>;
  interactive?: boolean;
}

export interface TaskToolDependencies {
  orchestratorFactory?: () => SubagentOrchestrator;
  profileManager?: ProfileManager;
  subagentManager?: SubagentManager;
}

interface TaskToolInvocationDeps {
  createOrchestrator: () => SubagentOrchestrator;
  getToolRegistry?: () => ToolRegistry | undefined;
}

/**
 * Formats a human readable summary for successful subagent execution.
 */
function formatSuccessDisplay(
  subagentName: string,
  agentId: string,
  output: OutputObject,
): string {
  const emittedVars = Object.entries(output.emitted_vars ?? {});
  const finalMessageSection = output.final_message
    ? `Final message:\n${output.final_message}`
    : 'Final message: _(none)_';
  const emittedSection =
    emittedVars.length === 0
      ? 'Emitted variables: _(none)_'
      : `Emitted variables:\n${emittedVars
          .map(([key, value]) => `- **${key}**: ${value}`)
          .join('\n')}`;

  return [
    `Subagent **${subagentName}** (\`${agentId}\`) completed with status \`${output.terminate_reason}\`.`,
    finalMessageSection,
    emittedSection,
  ].join('\n\n');
}

/**
 * Summarizes the subagent output as JSON for inclusion in tool history.
 */
function formatSuccessContent(agentId: string, output: OutputObject): string {
  const payload: Record<string, unknown> = {
    agent_id: agentId,
    terminate_reason: output.terminate_reason,
    emitted_vars: output.emitted_vars ?? {},
  };

  if (output.final_message !== undefined) {
    payload.final_message = output.final_message;
  }

  return JSON.stringify(payload, null, 2);
}

class TaskToolInvocation extends BaseToolInvocation<
  TaskToolParams,
  ToolResult
> {
  constructor(
    params: TaskToolParams,
    private readonly normalized: TaskToolInvocationParams,
    private readonly deps: TaskToolInvocationDeps,
  ) {
    super(params);
  }

  override getDescription(): string {
    return `Run subagent '${this.normalized.subagentName}' to accomplish: ${this.normalized.goalPrompt}`;
  }

  private createLaunchRequest(): SubagentLaunchRequest {
    const {
      subagentName,
      behaviourPrompts,
      runConfig,
      toolWhitelist,
      outputSpec,
    } = this.normalized;

    const launchRequest: SubagentLaunchRequest = {
      name: subagentName,
    };

    if (behaviourPrompts.length > 0) {
      launchRequest.behaviourPrompts = behaviourPrompts;
    }

    if (runConfig && Object.keys(runConfig).length > 0) {
      launchRequest.runConfig = {
        max_time_minutes: runConfig.max_time_minutes,
        max_turns: runConfig.max_turns,
      } as RunConfig;
    }

    let effectiveWhitelist = toolWhitelist;
    if (!effectiveWhitelist || effectiveWhitelist.length === 0) {
      const registry = this.deps.getToolRegistry?.();
      if (registry) {
        const excluded = new Set([
          'task',
          'Task',
          'list_subagents',
          'ListSubagents',
        ]);
        effectiveWhitelist = registry
          .getEnabledTools()
          .map((tool) => tool.name)
          .filter((name) => !!name && !excluded.has(name))
          .filter((name, index, array) => array.indexOf(name) === index);
      }
    }

    if (effectiveWhitelist && effectiveWhitelist.length > 0) {
      launchRequest.toolConfig = {
        tools: effectiveWhitelist,
      };
    }

    taskLogger.debug(() => {
      const summary =
        effectiveWhitelist && effectiveWhitelist.length > 0
          ? `${effectiveWhitelist.length} tools`
          : 'no tools provided';
      return `Prepared launch request for '${subagentName}': runConfig=${JSON.stringify(runConfig ?? {})}, toolConfig=${summary}`;
    });

    if (outputSpec && Object.keys(outputSpec).length > 0) {
      launchRequest.outputConfig = {
        outputs: outputSpec,
      };
    }

    return launchRequest;
  }

  override async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      return this.createCancelledResult(
        'Task execution aborted before launch.',
      );
    }

    let orchestrator: SubagentOrchestrator;
    try {
      orchestrator = this.deps.createOrchestrator();
    } catch (error) {
      taskLogger.warn(
        () =>
          `Failed to create orchestrator for '${this.normalized.subagentName}': ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.createErrorResult(
        error,
        'Task tool could not initialize subagent orchestrator.',
      );
    }

    const launchRequest = this.createLaunchRequest();
    taskLogger.debug(
      () =>
        `Launching subagent '${launchRequest.name}' with runConfig=${JSON.stringify(launchRequest.runConfig ?? {})}`,
    );

    let launchResult:
      | Awaited<ReturnType<SubagentOrchestrator['launch']>>
      | undefined;
    try {
      launchResult = await orchestrator.launch(launchRequest);
    } catch (error) {
      taskLogger.warn(
        () =>
          `Launch failure for '${launchRequest.name}': ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.createErrorResult(
        error,
        `Unable to launch subagent '${this.normalized.subagentName}'.`,
      );
    }

    const { scope, agentId, dispose } = launchResult;
    taskLogger.debug(
      () => `Subagent '${launchRequest.name}' started with agentId=${agentId}`,
    );
    const contextState = this.buildContextState();

    let aborted = false;
    const abortHandler = () => {
      if (aborted) {
        return;
      }
      aborted = true;
      taskLogger.warn(
        () => `Cancellation requested for subagent '${launchRequest.name}'`,
      );
      try {
        if (
          typeof (scope as { cancel?: (reason?: string) => void }).cancel ===
          'function'
        ) {
          (scope as { cancel?: (reason?: string) => void }).cancel?.(
            'User aborted task execution.',
          );
        }
      } catch (error) {
        taskLogger.warn(
          () =>
            `Error while cancelling subagent '${launchRequest.name}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    signal.addEventListener('abort', abortHandler);
    if (signal.aborted) {
      abortHandler();
    }

    const teardown = async () => {
      signal.removeEventListener('abort', abortHandler);
      try {
        await dispose();
      } catch {
        // Swallow dispose errors to avoid masking primary error.
      }
    };

    if (updateOutput) {
      const existingHandler = scope.onMessage;
      scope.onMessage = (message: string) => {
        if (message?.trim()) {
          updateOutput(`[${agentId}] ${message}`);
        }
        existingHandler?.(message);
      };
    }

    try {
      const shouldRunInteractive =
        this.normalized.interactive === undefined
          ? true
          : this.normalized.interactive;

      if (shouldRunInteractive && typeof scope.runInteractive === 'function') {
        await scope.runInteractive(contextState);
      } else {
        await scope.runNonInteractive(contextState);
      }
      if (aborted) {
        await teardown();
        taskLogger.warn(
          () => `Subagent '${launchRequest.name}' aborted before completion`,
        );
        return this.createCancelledResult(
          'Task execution aborted before completion.',
          agentId,
          scope.output,
        );
      }
      const output = scope.output ?? {
        terminate_reason: SubagentTerminateMode.ERROR,
        emitted_vars: {},
      };
      taskLogger.debug(
        () =>
          `Subagent '${launchRequest.name}' finished with reason=${output.terminate_reason} emittedKeys=${Object.keys(output.emitted_vars ?? {}).join(', ')}`,
      );
      const llmContent = formatSuccessContent(agentId, output);
      const returnDisplay = formatSuccessDisplay(
        this.normalized.subagentName,
        agentId,
        output,
      );
      await teardown();
      return {
        llmContent,
        returnDisplay,
        metadata: {
          agentId,
          terminateReason: output.terminate_reason,
          emittedVars: output.emitted_vars ?? {},
          ...(output.final_message
            ? { finalMessage: output.final_message }
            : {}),
        },
      };
    } catch (error) {
      const result = this.createErrorResult(
        error,
        `Subagent '${this.normalized.subagentName}' failed during execution.`,
        agentId,
      );
      await teardown();
      taskLogger.warn(
        () =>
          `Subagent '${launchRequest.name}' execution error: ${result.error?.message ?? 'unknown'}`,
      );
      return result;
    }
  }

  private buildContextState(): ContextState {
    const context = new ContextState();
    context.set('task_goal', this.normalized.goalPrompt);
    context.set('task_name', this.normalized.subagentName);
    for (const [key, value] of Object.entries(this.normalized.context)) {
      context.set(key, value);
    }
    context.set('task_behaviour_prompts', [
      ...this.normalized.behaviourPrompts,
    ]);
    return context;
  }

  private createErrorResult(
    error: unknown,
    fallbackMessage: string,
    agentId?: string,
  ): ToolResult {
    const detail =
      error instanceof Error && error.message ? error.message : null;
    const displayMessage = detail
      ? `${fallbackMessage}\nDetails: ${detail}`
      : fallbackMessage;
    const message = detail ?? fallbackMessage;
    taskLogger.warn(() => `Task tool error: ${displayMessage}`);
    return {
      llmContent: displayMessage,
      returnDisplay: displayMessage,
      metadata: agentId
        ? {
            agentId,
            error: message,
          }
        : undefined,
      error: {
        message,
        type: ToolErrorType.UNHANDLED_EXCEPTION,
      },
    };
  }

  private createCancelledResult(
    message: string,
    agentId?: string,
    output?: OutputObject,
  ): ToolResult {
    taskLogger.warn(
      () =>
        `Task tool cancelled for agentId=${agentId ?? DEFAULT_AGENT_ID}: ${message}`,
    );
    return {
      llmContent: message,
      returnDisplay: message,
      metadata: {
        agentId: agentId ?? DEFAULT_AGENT_ID,
        terminateReason: output?.terminate_reason,
        emittedVars: output?.emitted_vars ?? {},
        ...(output?.final_message
          ? { finalMessage: output.final_message }
          : {}),
        cancelled: true,
      },
      error: {
        message,
        type: ToolErrorType.UNHANDLED_EXCEPTION,
      },
    };
  }
}

/**
 * Task tool that launches subagents via SubagentOrchestrator.
 *
 * @plan PLAN-20251029-SUBAGENTIC
 * @requirement REQ-SUBAGENTIC-001, REQ-SUBAGENTIC-002
 */
export class TaskTool extends BaseDeclarativeTool<TaskToolParams, ToolResult> {
  static readonly Name = 'task';

  constructor(
    private readonly config: Config,
    private readonly dependencies: TaskToolDependencies = {},
  ) {
    super(
      TaskTool.Name,
      'Task',
      `Launches a named subagent, streams its progress, and returns the emitted variables upon completion. The subagent runs in an isolated runtime and is disposed after it finishes.`,
      Kind.Think,
      {
        type: 'object',
        additionalProperties: false,
        required: ['subagent_name', 'goal_prompt'],
        properties: {
          subagent_name: {
            type: 'string',
            description:
              'Name of the registered subagent to launch (as defined in ~/.llxprt/subagents).',
          },
          goal_prompt: {
            type: 'string',
            description:
              'Primary goal or prompt to pass to the subagent. Included as the first behavioural prompt.',
          },
          behaviour_prompts: {
            type: 'array',
            description:
              'Additional behavioural prompts to append after the goal prompt.',
            items: { type: 'string' },
          },
          run_limits: {
            type: 'object',
            additionalProperties: false,
            properties: {
              max_time_minutes: {
                type: 'number',
                description:
                  'Optional maximum number of minutes the subagent may run before timing out.',
              },
              max_turns: {
                type: 'number',
                description:
                  'Optional maximum number of turns before the subagent stops.',
              },
              interactive: {
                type: 'boolean',
                description:
                  'Set to false to force the subagent into non-interactive mode. Defaults to true.',
              },
            },
          },
          tool_whitelist: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Restrict the subagent to this explicit list of tools. Tool names must match the registry.',
          },
          output_spec: {
            type: 'object',
            description:
              'Expected output variables the subagent must emit before completing.',
            additionalProperties: { type: 'string' },
          },
          context: {
            type: 'object',
            description:
              'Optional key/value pairs exposed to the subagent via the execution context.',
            additionalProperties: true,
          },
        },
      },
      true,
      true,
    );
  }

  protected override validateToolParamValues(
    params: TaskToolParams,
  ): string | null {
    const subagentName =
      params.subagent_name ?? params.subagentName ?? params.subagentName;
    if (!subagentName || subagentName.trim().length === 0) {
      return 'Task tool requires a subagent_name.';
    }

    const goalPrompt =
      params.goal_prompt ?? params.goalPrompt ?? params.goalPrompt;
    if (!goalPrompt || goalPrompt.trim().length === 0) {
      return 'Task tool requires a goal_prompt describing the assignment.';
    }

    return null;
  }

  protected createInvocation(params: TaskToolParams): TaskToolInvocation {
    const normalized = this.normalizeParams(params);
    return new TaskToolInvocation(params, normalized, {
      createOrchestrator: () => this.ensureOrchestrator(),
      getToolRegistry:
        typeof this.config.getToolRegistry === 'function'
          ? () => this.config.getToolRegistry()
          : undefined,
    });
  }

  private normalizeParams(params: TaskToolParams): TaskToolInvocationParams {
    const subagentName = (
      params.subagent_name ??
      params.subagentName ??
      ''
    ).trim();
    const goalPrompt = (params.goal_prompt ?? params.goalPrompt ?? '').trim();

    const behaviourPrompts = [
      goalPrompt,
      ...(params.behaviour_prompts ??
        params.behavior_prompts ??
        params.behaviourPrompts ??
        params.behaviorPrompts ??
        []),
    ]
      .map((prompt) => prompt?.trim())
      .filter((prompt): prompt is string => Boolean(prompt))
      .filter((prompt, index, array) => array.indexOf(prompt) === index);

    const runLimits = (params.run_limits ?? params.runLimits ?? undefined) as
      | Partial<RunLimits>
      | undefined;

    let interactive: boolean | undefined;
    let runConfig: Partial<RunLimits> | undefined;
    if (runLimits && Object.keys(runLimits).length > 0) {
      const { interactive: interactiveFlag, ...rest } = runLimits;
      if (Object.keys(rest).length > 0) {
        runConfig = { ...rest } as Partial<RunLimits>;
      }
      if (typeof interactiveFlag === 'boolean') {
        interactive = interactiveFlag;
      }
    }

    const toolWhitelist = (params.tool_whitelist ?? params.toolWhitelist ?? [])
      .map((tool) => tool?.trim())
      .filter((tool): tool is string => Boolean(tool));

    const outputSpec = params.output_spec ?? params.outputSpec ?? undefined;

    const context =
      params.context ?? params.context_vars ?? params.contextVars ?? {};

    return {
      subagentName,
      goalPrompt,
      behaviourPrompts,
      runConfig,
      toolWhitelist: toolWhitelist.length > 0 ? toolWhitelist : undefined,
      outputSpec,
      context,
      interactive,
    };
  }

  private ensureOrchestrator(): SubagentOrchestrator {
    if (this.dependencies.orchestratorFactory) {
      return this.dependencies.orchestratorFactory();
    }

    const configWithManagers = this.config as Config & {
      getProfileManager?: () => ProfileManager | undefined;
      getSubagentManager?: () => SubagentManager | undefined;
    };

    const profileManager =
      this.dependencies.profileManager ??
      configWithManagers.getProfileManager?.();
    const subagentManager =
      this.dependencies.subagentManager ??
      configWithManagers.getSubagentManager?.();

    if (!profileManager || !subagentManager) {
      throw new Error(
        'Task tool requires profile and subagent managers to be configured.',
      );
    }

    return new SubagentOrchestrator({
      subagentManager,
      profileManager,
      foregroundConfig: this.config,
    });
  }
}

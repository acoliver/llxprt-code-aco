import path from 'node:path';
import {
  TemplateVariables,
  TemplateProcessingOptions,
  PromptContext,
} from './types.js';

/**
 * TemplateEngine - Handles variable substitution in prompt templates
 *
 * Implements REQ-004: Template Processing requirements
 * - Supports {{VARIABLE_NAME}} syntax
 * - Substitutes TOOL_NAME, MODEL, and PROVIDER variables
 * - Handles malformed templates gracefully
 * - Logs substitutions when DEBUG=1 (REQ-010.4)
 */
export class TemplateEngine {
  /**
   * Process a template string with variable substitution
   * @param content Template content with {{variables}}
   * @param variables Map of variable names to values
   * @param options Optional processing configuration
   * @returns Processed content with variables substituted
   */
  processTemplate(
    content: string,
    variables: TemplateVariables,
    options?: TemplateProcessingOptions,
  ): string {
    // Step 1: Validate inputs
    if (content === null || content === undefined) {
      return '';
    }

    if (typeof content !== 'string') {
      return content;
    }

    const vars = variables || {};

    // Step 2: Initialize processing state
    let result = '';
    let currentPosition = 0;
    const contentLength = content.length;

    // Step 3: Process template
    while (currentPosition < contentLength) {
      // Find position of next "{{"
      const openBracketPos = content.indexOf('{{', currentPosition);

      if (openBracketPos === -1) {
        // No more variables, append rest and break
        result += content.substring(currentPosition);
        break;
      }

      // Append content before "{{"
      result += content.substring(currentPosition, openBracketPos);

      // Find position of next "}}"
      const closeBracketPos = content.indexOf('}}', openBracketPos + 2);

      if (closeBracketPos === -1) {
        // No closing brackets, append rest and break
        result += content.substring(openBracketPos);
        break;
      }

      // Extract variable name and trim whitespace
      const variableName = content
        .substring(openBracketPos + 2, closeBracketPos)
        .trim();

      // Handle empty variable names - leave as-is
      if (variableName === '') {
        result += content.substring(openBracketPos, closeBracketPos + 2);
        currentPosition = closeBracketPos + 2;
        continue;
      }

      // Check if variable name contains brackets (nested variables not supported)
      if (variableName.includes('{{') || variableName.includes('}}')) {
        // Leave the whole pattern as-is and move to next character
        result += content.substring(openBracketPos, openBracketPos + 2);
        currentPosition = openBracketPos + 2;
        continue;
      }

      // Perform substitution
      if (variableName in vars) {
        const variableValue = vars[variableName];
        if (variableValue === null || variableValue === undefined) {
          // Append empty string
          result += '';
        } else {
          result += String(variableValue);
          // Log substitution if debug is enabled
          this.logSubstitution(variableName, String(variableValue), options);
        }
      } else {
        // Variable not found, substitute with empty string
        result += '';
        this.logSubstitution(variableName, '', options);
      }

      // Update position to after "}}"
      currentPosition = closeBracketPos + 2;
    }

    return result;
  }

  /**
   * Create template variables from runtime context
   * @param context Runtime context with provider, model, tools, and environment
   * @param currentTool Optional current tool being processed
   * @returns Map of variable names to values
   */
  createVariablesFromContext(
    context: PromptContext,
    currentTool: string | null = null,
  ): TemplateVariables {
    // Validate context - return minimal valid object if no context
    if (!context) {
      return {
        MODEL: '',
        PROVIDER: '',
      };
    }

    // Initialize variables map with required fields
    const variables: TemplateVariables = {
      MODEL: context.model || '',
      PROVIDER: context.provider || '',
    };

    // Add tool-specific variable
    if (currentTool && currentTool.trim()) {
      variables['TOOL_NAME'] = currentTool;
    }

    // Add environment variables
    if (context.environment) {
      variables['IS_GIT_REPO'] = context.environment.isGitRepository
        ? 'true'
        : 'false';
      variables['IS_SANDBOXED'] = context.environment.isSandboxed
        ? 'true'
        : 'false';
      variables['HAS_IDE'] = context.environment.hasIdeCompanion
        ? 'true'
        : 'false';

      if (context.environment.workingDirectory) {
        variables['WORKING_DIRECTORY'] = context.environment.workingDirectory;
      }
      if (context.environment.folderStructure) {
        variables['FOLDER_STRUCTURE'] = context.environment.folderStructure;
      }

      if (context.environment.sandboxType) {
        variables['SANDBOX_TYPE'] = context.environment.sandboxType;
      } else {
        variables['SANDBOX_TYPE'] = context.environment.isSandboxed
          ? 'unknown'
          : 'none';
      }

      const workspaceName =
        context.environment.workspaceName ||
        (context.environment.workingDirectory
          ? path.basename(context.environment.workingDirectory)
          : '');
      if (workspaceName) {
        variables['WORKSPACE_NAME'] = workspaceName;
      } else {
        variables['WORKSPACE_NAME'] = 'unknown';
      }

      const workspaceRoot =
        context.environment.workspaceRoot ||
        context.environment.workingDirectory;
      if (workspaceRoot) {
        variables['WORKSPACE_ROOT'] = workspaceRoot;
      } else {
        variables['WORKSPACE_ROOT'] = 'unknown';
      }

      const workspaceDirectories =
        context.environment.workspaceDirectories ||
        (context.environment.workingDirectory
          ? [context.environment.workingDirectory]
          : []);
      if (workspaceDirectories.length > 0) {
        variables['WORKSPACE_DIRECTORIES'] = workspaceDirectories.join(', ');
      } else {
        variables['WORKSPACE_DIRECTORIES'] = 'unknown';
      }
    }

    // Add derived variables
    if (context.provider) {
      variables['PROVIDER_UPPER'] = context.provider.toUpperCase();
    }
    if (context.model) {
      variables['MODEL_SAFE'] = context.model.replace(/[^a-zA-Z0-9]/g, '_');
    }

    // Add current date and time
    const now = new Date();
    variables['CURRENT_DATE'] = now.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    variables['CURRENT_TIME'] = now.toLocaleTimeString();
    variables['CURRENT_DATETIME'] = now.toLocaleString();
    variables['PLATFORM'] = process.platform;

    return variables;
  }

  /**
   * Log variable substitution for debugging (when DEBUG=1)
   * @param variable Variable name being substituted
   * @param value Value being substituted
   * @param options Processing options
   */
  private logSubstitution(
    variable: string,
    value: string,
    options?: TemplateProcessingOptions,
  ): void {
    // Check if debug is enabled via environment variable or options
    const debugEnabled = process.env.DEBUG === '1' || options?.debug === true;

    if (debugEnabled) {
      console.log(`Template substitution: ${variable} -> ${value}`);
    }
  }
}

// Export the class as default for convenience
export default TemplateEngine;

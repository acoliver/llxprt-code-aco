/**
 * @license
 * Copyright 2025 Vybestack LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Profile } from '../types/modelParams.js';
import type { SettingsService } from '../settings/SettingsService.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * Manages saving and loading of configuration profiles.
 * Profiles are stored in ~/.llxprt/profiles/<profileName>.json
 *
 * @plan:PLAN-20250117-SUBAGENTCONFIG.P04
 * @requirement:REQ-018
 */
export class ProfileManager {
  private profilesDir: string;

  /**
   * @param profilesDir Optional custom directory for testing. If not provided, uses ~/.llxprt/profiles.
   */
  constructor(profilesDir?: string) {
    this.profilesDir =
      profilesDir || path.join(os.homedir(), '.llxprt', 'profiles');
  }

  /**
   * Save the current configuration to a profile.
   * @param profileName The name of the profile to save
   * @param profile The profile configuration to save
   */
  async saveProfile(profileName: string, profile: Profile): Promise<void> {
    // Ensure profiles directory exists
    await fs.mkdir(this.profilesDir, { recursive: true });

    // Construct the file path
    const filePath = path.join(this.profilesDir, `${profileName}.json`);

    // Write the profile to file with nice formatting
    await fs.writeFile(filePath, JSON.stringify(profile, null, 2), 'utf8');
  }

  /**
   * Load a profile configuration.
   * @param profileName The name of the profile to load
   * @returns The loaded profile configuration
   */
  async loadProfile(profileName: string): Promise<Profile> {
    // Construct the file path
    const filePath = path.join(this.profilesDir, `${profileName}.json`);

    try {
      // Read the profile file
      const content = await fs.readFile(filePath, 'utf8');

      // Parse JSON
      const profile = JSON.parse(content) as Profile;

      // Validate required fields
      if (
        !profile.version ||
        !profile.provider ||
        !profile.model ||
        !profile.modelParams ||
        !profile.ephemeralSettings
      ) {
        throw new Error('missing required fields');
      }

      // Check version
      if (profile.version !== 1) {
        throw new Error('unsupported profile version');
      }

      return profile;
    } catch (error) {
      if (error instanceof Error && error.message.includes('ENOENT')) {
        throw new Error(`Profile '${profileName}' not found`);
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Profile '${profileName}' is corrupted`);
      }
      if (
        error instanceof Error &&
        error.message === 'missing required fields'
      ) {
        throw new Error(
          `Profile '${profileName}' is invalid: missing required fields`,
        );
      }
      throw error;
    }
  }

  /**
   * List all available profile names.
   * @returns Array of profile names (without .json extension)
   */
  async listProfiles(): Promise<string[]> {
    try {
      // Ensure profiles directory exists
      await fs.mkdir(this.profilesDir, { recursive: true });

      // Read all files in the profiles directory
      const files = await fs.readdir(this.profilesDir);

      // Filter for .json files and remove extension
      const profileNames = files
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.slice(0, -5)); // Remove .json extension

      return profileNames;
    } catch (_error) {
      // If directory doesn't exist or other error, return empty array
      return [];
    }
  }

  /**
   * Delete a profile.
   * @param profileName The name of the profile to delete
   */
  async deleteProfile(profileName: string): Promise<void> {
    const filePath = path.join(this.profilesDir, `${profileName}.json`);

    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error instanceof Error && error.message.includes('ENOENT')) {
        throw new Error(`Profile '${profileName}' not found`);
      }
      throw error;
    }
  }

  /**
   * Check if a profile exists.
   * @param profileName The name of the profile to check
   * @returns True if the profile exists
   */
  async profileExists(profileName: string): Promise<boolean> {
    const filePath = path.join(this.profilesDir, `${profileName}.json`);
    try {
      await fs.access(filePath);
      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Save current settings to a profile through SettingsService
   * @param profileName The name of the profile to save
   */
  /**
   * @plan:PLAN-20250218-STATELESSPROVIDER.P07
   * @requirement:REQ-SP-005
   * Persist profile data through the injected SettingsService instead of the
   * legacy singleton accessor.
   * @pseudocode:cli-runtime.md lines 9-11
   */
  async save(
    profileName: string,
    settingsService: SettingsService,
  ): Promise<void> {
    // Use SettingsService to export current settings
    if (!settingsService.exportForProfile) {
      throw new Error('SettingsService does not support profile export');
    }
    const settingsData = await settingsService.exportForProfile();

    // Convert SettingsService format to Profile format
    // We need to extract provider/model from the default provider settings
    const defaultProvider = settingsData.defaultProvider;
    const providerSettings = settingsData.providers[defaultProvider];

    const profile: Profile = {
      version: 1,
      provider: defaultProvider,
      model: providerSettings?.model || 'default',
      modelParams: {
        temperature: providerSettings?.temperature,
        max_tokens: providerSettings?.maxTokens,
      },
      ephemeralSettings: {
        'base-url': providerSettings?.baseUrl,
        'auth-key': providerSettings?.apiKey,
      },
    };

    const toolsAllowed = Array.isArray(settingsData.tools?.allowed)
      ? [...(settingsData.tools?.allowed as string[])]
      : [];
    const toolsDisabled = Array.isArray(settingsData.tools?.disabled)
      ? [...(settingsData.tools?.disabled as string[])]
      : [];

    profile.ephemeralSettings['tools.allowed'] = toolsAllowed;
    profile.ephemeralSettings['tools.disabled'] = toolsDisabled;
    profile.ephemeralSettings['disabled-tools'] = toolsDisabled;

    // Update current profile name in SettingsService
    if (settingsService.setCurrentProfileName) {
      settingsService.setCurrentProfileName(profileName);
    }

    // Save to file using existing method for consistency
    await this.saveProfile(profileName, profile);
  }

  /**
   * Load a profile and apply through SettingsService
   * @param profileName The name of the profile to load
   */
  /**
   * @plan:PLAN-20250218-STATELESSPROVIDER.P07
   * @requirement:REQ-SP-005
   * Apply profiles via the injected SettingsService rather than the singleton.
   * @pseudocode:cli-runtime.md lines 9-11
   */
  async load(
    profileName: string,
    settingsService: SettingsService,
  ): Promise<void> {
    // Load profile from file
    const profile = await this.loadProfile(profileName);

    // Convert Profile format to SettingsService format
    const settingsData = {
      defaultProvider: profile.provider,
      providers: {
        [profile.provider]: {
          enabled: true,
          model: profile.model,
          temperature: profile.modelParams.temperature,
          maxTokens: profile.modelParams.max_tokens,
          baseUrl: profile.ephemeralSettings['base-url'],
          apiKey: profile.ephemeralSettings['auth-key'],
        },
      },
      tools: {
        allowed: Array.isArray(profile.ephemeralSettings['tools.allowed'])
          ? [...(profile.ephemeralSettings['tools.allowed'] as string[])]
          : [],
        disabled: Array.isArray(profile.ephemeralSettings['tools.disabled'])
          ? [...(profile.ephemeralSettings['tools.disabled'] as string[])]
          : Array.isArray(profile.ephemeralSettings['disabled-tools'])
            ? [...(profile.ephemeralSettings['disabled-tools'] as string[])]
            : [],
      },
    };

    // Update current profile name first
    if (settingsService.setCurrentProfileName) {
      settingsService.setCurrentProfileName(profileName);
    }

    // Apply through SettingsService
    if (!settingsService.importFromProfile) {
      throw new Error('SettingsService does not support profile import');
    }
    await settingsService.importFromProfile(settingsData);

    if (settingsData.tools) {
      const allowedList = Array.isArray(settingsData.tools.allowed)
        ? settingsData.tools.allowed
        : [];
      const disabledList = Array.isArray(settingsData.tools.disabled)
        ? settingsData.tools.disabled
        : [];
      settingsService.set('tools.allowed', allowedList);
      settingsService.set('tools.disabled', disabledList);
      settingsService.set('disabled-tools', disabledList);
    }
  }
}

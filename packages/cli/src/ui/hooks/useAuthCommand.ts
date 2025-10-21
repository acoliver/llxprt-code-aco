/**
 * @license
 * Copyright 2025 Vybestack LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { AuthType, Config, getErrorMessage } from '@vybestack/llxprt-code-core';
import { useAppDispatch } from '../contexts/AppDispatchContext.js';
import { AppState } from '../reducers/appReducer.js';
import { useRuntimeApi } from '../contexts/RuntimeContext.js';

export const useAuthCommand = (
  settings: LoadedSettings,
  appState: AppState,
  config: Config,
) => {
  const appDispatch = useAppDispatch();
  const runtime = useRuntimeApi();
  const isAuthDialogOpen = appState.openDialogs.auth;

  // Commented out to implement lazy authentication
  // Auth dialog will only open when explicitly triggered
  // useEffect(() => {
  //   if (settings.merged.selectedAuthType === undefined) {
  //     appDispatch({ type: 'OPEN_DIALOG', payload: 'auth' });
  //   }
  // }, [settings.merged.selectedAuthType, appDispatch]); // Run only on mount

  const openAuthDialog = useCallback(() => {
    appDispatch({ type: 'OPEN_DIALOG', payload: 'auth' });
  }, [appDispatch]);

  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    const authFlow = async () => {
      const authType = settings.merged.selectedAuthType;
      if (isAuthDialogOpen || !authType) {
        return;
      }

      try {
        setIsAuthenticating(true);
        await config.refreshAuth(authType);

        // Apply compression settings after authentication
        const contextLimit = config.getEphemeralSetting('context-limit') as
          | number
          | undefined;
        const compressionThreshold = config.getEphemeralSetting(
          'compression-threshold',
        ) as number | undefined;

        // Set compression settings via ephemeral settings
        if (compressionThreshold !== undefined) {
          config.setEphemeralSetting(
            'compression-threshold',
            compressionThreshold,
          );
        }
        if (contextLimit !== undefined) {
          config.setEphemeralSetting('context-limit', contextLimit);
        }

        // Update serverToolsProvider after authentication
        const providerManager = runtime.getCliProviderManager();
        if (providerManager) {
          const serverToolsProvider = providerManager.getServerToolsProvider();
          if (
            serverToolsProvider &&
            serverToolsProvider.name === 'gemini' &&
            'setConfig' in serverToolsProvider
          ) {
            // This will trigger determineBestAuth() with the new auth state
            const geminiProvider = serverToolsProvider as {
              setConfig: (config: Config) => void;
            };
            geminiProvider.setConfig(config);
          }
        }

        console.log(`Authenticated via "${authType}".`);
      } catch (e) {
        const errorMessage = getErrorMessage(e);
        appDispatch({
          type: 'SET_AUTH_ERROR',
          payload: `Failed to login. Message: ${errorMessage}`,
        });
        // NEVER automatically open auth dialog - user must use /auth command
      } finally {
        setIsAuthenticating(false);
      }
    };

    void authFlow();
  }, [
    isAuthDialogOpen,
    settings,
    config,
    appDispatch,
    openAuthDialog,
    runtime,
  ]);

  const handleAuthSelect = useCallback(
    async (authType: AuthType | undefined, scope: SettingScope) => {
      // If undefined passed, it means close was selected
      if (authType === undefined) {
        // Close the dialog
        appDispatch({ type: 'CLOSE_DIALOG', payload: 'auth' });
        appDispatch({ type: 'SET_AUTH_ERROR', payload: null });
        return;
      }

      // Save the selected auth type - NO OAuth flow triggering
      settings.setValue(scope, 'selectedAuthType', authType);
      // Don't close dialog - let user continue toggling providers
    },
    [settings, appDispatch],
  );

  const cancelAuthentication = useCallback(() => {
    setIsAuthenticating(false);
  }, []);

  return {
    isAuthDialogOpen,
    openAuthDialog,
    handleAuthSelect,
    isAuthenticating,
    cancelAuthentication,
  };
};

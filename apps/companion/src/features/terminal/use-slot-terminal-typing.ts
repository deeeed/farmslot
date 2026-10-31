import * as Haptics from 'expo-haptics';
import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useCallback,
} from 'react';

import type { TerminalControlKey } from '../../lib/terminal-controls';
import {
  keysRetryingNotice,
  TerminalInputCancelledError,
  withoutKeysRetryingNotice,
} from '../../lib/terminal-input-queue';
import type { CompanionTerminalTargetParams } from '../../lib/terminal-target';

import { useTerminalControlKeys } from './use-terminal-control-keys';
import { useTerminalInput } from './use-terminal-input';

interface SlotTerminalTypingOptions {
  connected: boolean;
  target: CompanionTerminalTargetParams | null;
  targetRef: RefObject<CompanionTerminalTargetParams | null>;
  disabledReason: string | null;
  /** Throws when input cannot go to the current target; `current()` says whether it still is. */
  requireTarget: (input: boolean) => { current: () => boolean };
  setControlError: Dispatch<SetStateAction<string | null>>;
  setInputError: (message: string) => void;
  /** Counts input commands for the development proof. */
  commandCount: MutableRefObject<number>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Typing into a slot terminal: the input line and the key bar share one ordered queue. */
export function useSlotTerminalTyping({
  connected,
  target,
  targetRef,
  disabledReason,
  requireTarget,
  setControlError,
  setInputError,
  commandCount,
}: SlotTerminalTypingOptions) {
  const input = useTerminalInput(target, targetRef, disabledReason, {
    onRetry: (error, attempt) =>
      setControlError((current) => keysRetryingNotice(error, attempt) ?? current),
  });
  const write = input.write;
  const clearKeysRetrying = useCallback(
    () => setControlError(withoutKeysRetryingNotice),
    [setControlError],
  );

  const typeKeys = useCallback(
    (data: string) => {
      if (disabledReason || !connected) return;
      try {
        const captured = requireTarget(true);
        write(data).then(clearKeysRetrying, (error: unknown) => {
          // Only leaving the terminal discards unsent input; failures are retried in order.
          if (!(error instanceof TerminalInputCancelledError) && captured.current())
            setInputError(`Terminal input failed: ${errorText(error)}`);
        });
      } catch (error) {
        setInputError(errorText(error));
      }
    },
    [clearKeysRetrying, connected, disabledReason, requireTarget, setInputError, write],
  );

  const sendControlKey = useCallback(
    async (control: TerminalControlKey) => {
      if (!connected || disabledReason) return;
      let captured: { current: () => boolean };
      try {
        captured = requireTarget(true);
      } catch (error) {
        setControlError(errorText(error));
        return;
      }
      setControlError(null);
      commandCount.current++;
      void Haptics.impactAsync(
        control.danger ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light,
      );
      try {
        await write(control.data);
        clearKeysRetrying();
      } catch (error) {
        if (!(error instanceof TerminalInputCancelledError) && captured.current())
          setControlError(`Control failed: ${errorText(error)}`);
      }
    },
    [
      clearKeysRetrying,
      commandCount,
      connected,
      disabledReason,
      requireTarget,
      setControlError,
      write,
    ],
  );
  const controlKeys = useTerminalControlKeys(sendControlKey);

  return { typeKeys, controlKeys };
}

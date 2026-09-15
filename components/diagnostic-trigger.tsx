'use client';

import type { JSX } from 'react';
import { useState } from 'react';

const CHANNEL_ID = 'C0C1GJNPV0V';

type TriggerState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'accepted' }
  | { kind: 'error'; message: string };

export function DiagnosticTrigger(): JSX.Element {
  const [state, setState] = useState<TriggerState>({ kind: 'idle' });

  async function trigger() {
    setState({ kind: 'running' });
    try {
      const response = await fetch('/eve/v1/diagnostic-trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId: CHANNEL_ID }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        status?: string;
      };
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error ?? payload.status ?? 'Trigger was not accepted');
      }
      setState({ kind: 'accepted' });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Trigger was not accepted',
      });
    }
  }

  const status = state.kind === 'running'
    ? 'Starting the 15-account Eve diagnostic…'
    : state.kind === 'accepted'
      ? 'Accepted. Watch the Slack channel for the BLUF and thread detail.'
      : state.kind === 'error'
        ? state.message
        : 'Starts one read-only diagnostic for the allowlisted Account Signals channel.';

  return (
    <div className="flex flex-col gap-4">
      <button
        className="inline-flex h-10 w-fit items-center justify-center rounded-md bg-gray-1000 px-4 text-button-14 text-[var(--ds-background-100)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2"
        disabled={state.kind === 'running'}
        onClick={trigger}
        type="button"
      >
        {state.kind === 'running' ? 'Starting…' : 'Run diagnostic now'}
      </button>
      <p
        aria-live="polite"
        className={`text-copy-13 ${state.kind === 'error' ? 'text-red-700' : 'text-gray-800'}`}
      >
        {status}
      </p>
    </div>
  );
}

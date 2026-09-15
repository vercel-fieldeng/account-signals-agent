import type { JSX } from 'react';
import { Badge } from '@vercel/geistcn/components/badge';
import { LogoVercel } from '@vercel/geistcn-assets/logos';
import { Card } from '@/components/ui/card';
import { DiagnosticTrigger } from '@/components/diagnostic-trigger';

const slackChannelUrl =
  'https://vercel.enterprise.slack.com/archives/C0C1GJNPV0V';

const connectionSteps = [
  {
    label: 'Slack',
    detail: 'Account Signals',
  },
  {
    label: 'Vercel Connect',
    detail: 'Verified events',
  },
  {
    label: 'eve',
    detail: 'Durable agent',
  },
];

export default function Page(): JSX.Element {
  return (
    <div className="min-h-svh bg-[var(--ds-background-200)] text-gray-1000">
      <header className="border-b border-[var(--ds-gray-alpha-400)] bg-[var(--ds-background-100)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3">
            <LogoVercel height={18} aria-label="Vercel" />
            <span
              aria-hidden="true"
              className="h-5 w-px bg-[var(--ds-gray-alpha-400)]"
            />
            <span className="text-heading-16">Account Signals Agent</span>
          </div>
          <Badge variant="green" size="md">
            Connected
          </Badge>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-16 px-5 py-16 sm:px-8 sm:py-24">
        <section className="flex max-w-3xl flex-col gap-6">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-green-700" />
            <span className="text-label-13 text-gray-900">
              Slack channel active
            </span>
          </div>
          <div className="flex flex-col gap-4">
            <h1 className="text-heading-48 text-balance sm:text-heading-64">
              Say hello to your first eve agent.
            </h1>
            <p className="max-w-2xl text-copy-18 text-pretty text-gray-900 sm:text-copy-20">
              Mention the agent in Account Signals and it will reply in the
              same thread. This small first step confirms the complete Slack
              delivery path is ready.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <a
              className="inline-flex h-10 items-center justify-center rounded-md bg-gray-1000 px-4 text-button-14 text-[var(--ds-background-100)] transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2"
              href={slackChannelUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open Slack Channel
            </a>
            <span className="font-mono text-copy-13 text-gray-700">
              #C0C1GJNPV0V
            </span>
          </div>
        </section>

        <section aria-labelledby="diagnostic-heading">
          <Card className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex max-w-2xl flex-col gap-2">
              <p className="text-label-13 text-gray-700">PRODUCTION RUN</p>
              <h2 id="diagnostic-heading" className="text-heading-24">
                Run the 15-account diagnostic
              </h2>
              <p className="text-copy-14 text-gray-800">
                Starts one read-only Eve run for the allowlisted Account Signals channel. The result is delivered as a BLUF with detail in a Slack thread.
              </p>
            </div>
            <DiagnosticTrigger />
          </Card>
        </section>

        <section aria-labelledby="connection-heading" className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <p className="text-label-13 text-gray-700">CONNECTION</p>
            <h2 id="connection-heading" className="text-heading-24">
              One message, end to end
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {connectionSteps.map((step, index) => (
              <Card className="flex min-h-40 flex-col justify-between p-5" key={step.label}>
                <span className="font-mono text-copy-13 text-gray-700">
                  0{index + 1}
                </span>
                <div className="flex flex-col gap-1">
                  <h3 className="text-heading-18">{step.label}</h3>
                  <p className="text-copy-14 text-gray-800">{step.detail}</p>
                </div>
              </Card>
            ))}
          </div>
        </section>

        <Card className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <h2 className="text-heading-18">Try the hello-world flow</h2>
            <p className="text-copy-14 text-gray-800">
              Mention the bot in the channel with a short greeting.
            </p>
          </div>
          <code className="rounded-md border border-[var(--ds-gray-alpha-400)] bg-[var(--ds-background-200)] px-3 py-2 font-mono text-copy-13 text-gray-900">
            @Account Signals hello
          </code>
        </Card>
      </main>

      <footer className="border-t border-[var(--ds-gray-alpha-400)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-6 sm:px-8">
          <span className="text-copy-13 text-gray-700">Built with eve</span>
          <span className="text-copy-13 text-gray-700">
            Connector: account-signals-slack
          </span>
        </div>
      </footer>
    </div>
  );
}

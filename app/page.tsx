import type { JSX } from 'react';
import { LogoVercel } from '@vercel/geistcn-assets/logos';

export default function Page(): JSX.Element {
  return (
    <main
      data-v0-design-system-placeholder=""
      style={{
        position: 'relative',
        display: 'flex',
        minHeight: '100svh',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '24px',
          left: '24px',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <LogoVercel height={20} aria-label="Vercel" />
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '8px',
          textAlign: 'center',
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: '15px',
            lineHeight: 1.5,
            opacity: 0.65,
          }}
        >
          Your v0 generation will show here.
        </p>
        <span
          style={{
            fontSize: '13px',
            fontWeight: 500,
            opacity: 0.4,
          }}
        >
          Geist Design System
        </span>
      </div>
    </main>
  );
}

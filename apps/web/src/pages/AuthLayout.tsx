/**
 * The two-panel sign-in frame from the design: illustration and the three
 * things this tool does on the left, the form on the right.
 *
 * The left panel carries real content rather than decoration — somebody
 * arriving at this screen for the first time should learn what BakeCheck
 * does before they decide to make an account.
 */
import type { ReactNode } from 'react';
import { Icon } from '../components/ui';
import './AuthLayout.css';

const STEPS = [
  {
    icon: 'photo_camera',
    text: 'Photograph the developed tube against a plain background.',
  },
  {
    icon: 'colorize',
    text: 'BakeCheck measures the solution colour and finds the nearest band on your reference chart.',
  },
  {
    icon: 'fact_check',
    text: 'Record the observation, then confirm anything of concern by laboratory analysis.',
  },
];

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="auth">
      <section className="auth-aside">
        <img
          src="/brand/bakecheck-logo.png"
          alt="BakeCheck"
          className="auth-logo"
          width={168}
          height={32}
        />

        <img
          src="/brand/lab-illustration.jpg"
          alt=""
          className="auth-art"
          width={360}
          height={360}
        />

        <h2 className="auth-aside-title">Screen a sample in three steps</h2>
        <ol className="auth-steps">
          {STEPS.map((step) => (
            <li key={step.icon}>
              <Icon name={step.icon} className="icon-sm auth-step-icon" />
              <span>{step.text}</span>
            </li>
          ))}
        </ol>

        <p className="auth-caveat">
          BakeCheck is a screening aid. It reports the colour it observes, not
          a confirmed bromate concentration.
        </p>
      </section>

      <section className="auth-main">
        <div className="auth-form">
          <h1 className="auth-title">{title}</h1>
          <p className="auth-subtitle">{subtitle}</p>
          {children}
        </div>
      </section>
    </div>
  );
}

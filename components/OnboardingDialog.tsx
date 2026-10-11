"use client";

import { useI18n } from "@/hooks/useI18n";

export function OnboardingDialog({ onConfigure, onLater }: { onConfigure: () => void; onLater: () => void }) {
  const { t } = useI18n();

  return (
    <div
      className="onboarding-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      onClick={(event) => { if (event.target === event.currentTarget) onLater(); }}
    >
      <div className="onboarding-card">
        <button type="button" className="onboarding-close" aria-label={t("i18n.close")} onClick={onLater}>×</button>
        {/* The onboarding mark is a small, fixed public brand asset. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="onboarding-mark" src="/pi-chat-mark.png" alt="" aria-hidden="true" />
        <h1 id="onboarding-title" className="onboarding-title">{t("onboarding.title")}</h1>
        <p className="onboarding-description">{t("onboarding.description")}</p>
        <div className="onboarding-actions">
          <button type="button" className="onboarding-primary" onClick={onConfigure}>{t("onboarding.configure")}</button>
          <button type="button" className="onboarding-secondary" onClick={onLater}>{t("onboarding.later")}</button>
        </div>
      </div>
    </div>
  );
}

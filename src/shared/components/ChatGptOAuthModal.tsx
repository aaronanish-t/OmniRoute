"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { parseChatGptManualCallback } from "@/shared/utils/chatgptCallback";
import Modal from "./Modal";
import Button from "./Button";
import ChatGptSignInButton from "./ChatGptSignInButton";
import { ChatGptPlanWelcome } from "./ChatGptPlanUi";
import { acknowledgeChatGptPlan, shouldWelcomeChatGptPlan } from "@/shared/utils/chatgptPlanUi";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  reauthConnection?: { id: string } | null;
};
async function session(body: Record<string, unknown>, fallback = "") {
  const response = await fetch("/api/oauth/chatgpt/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || fallback);
  return result;
}

const redirectUri = "http://127.0.0.1:1455/auth/callback";
export default function ChatGptOAuthModal(props: Props) {
  return props.isOpen ? <ChatGptOAuthDialog {...props} /> : null;
}

function ChatGptOAuthDialog({ isOpen, onClose, onSuccess, reauthConnection }: Props) {
  const t = useTranslations("chatgptSignIn");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [attempt, setAttempt] = useState<{ state: string; authUrl: string } | null>(null);
  const stateRef = useRef<string | null>(null);
  const generation = useRef(0);
  const [done, setDone] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const connectionId = reauthConnection?.id;

  const start = useCallback(async () => {
    const current = ++generation.current;
    try {
      if (stateRef.current) await session({ action: "cancel", state: stateRef.current });
      if (current !== generation.current) return;
      stateRef.current = null;
      const result = await session(
        { action: "start", port: 1455, connectionId },
        t("connectionError")
      );
      if (current !== generation.current) {
        void session({ action: "cancel", state: result.state }).catch(() => {});
        return;
      }
      stateRef.current = result.state;
      setAttempt(result);
    } catch (err) {
      if (current === generation.current)
        setError(err instanceof Error && err.message ? err.message : t("startError"));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }, [connectionId, t]);

  useEffect(() => {
    const lifecycle = generation;
    // Skip abandoned/Strict Mode mounts before creating a server-side OAuth attempt.
    const timer = setTimeout(() => void start(), 0);
    return () => {
      clearTimeout(timer);
      lifecycle.current++;
      const state = stateRef.current;
      stateRef.current = null;
      if (state) void session({ action: "cancel", state }).catch(() => {});
    };
  }, [start]);

  async function complete() {
    if (!attempt || busy) return;
    setError("");
    try {
      parseChatGptManualCallback(callbackUrl, { redirectUri, state: attempt.state });
    } catch {
      setError(t("callbackError"));
      return;
    }
    setBusy(true);
    const current = generation.current;
    const pasted = callbackUrl;
    // Never persist the one-time code in browser storage; clear the form on submission.
    setCallbackUrl("");
    try {
      const result = await session({
        action: "complete-url",
        state: attempt.state,
        callbackUrl: pasted,
      });
      if (current !== generation.current) return;
      stateRef.current = null;
      setShowWelcome(result.planAuthorized === true && shouldWelcomeChatGptPlan(!!connectionId));
      setDone(true);
      setWarning(result.warning || "");
    } catch (err) {
      if (current === generation.current)
        setError(err instanceof Error && err.message ? err.message : t("completeError"));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  function finish() {
    if (showWelcome) acknowledgeChatGptPlan();
    onSuccess();
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={done ? finish : onClose}
      title={t("title")}
      size="full"
      className="max-h-[90vh] overflow-y-auto"
    >
      <div className="space-y-6">
        {!done && (
          <>
            <p className="text-text-muted">{t("description")}</p>
            <p className="rounded-lg border border-border p-3 text-sm">{t("eligibility")}</p>
          </>
        )}
        {done ? (
          <div className="space-y-4">
            <p role="status">{t("connected")}</p>
            {warning && <p className="rounded-lg border border-amber-500 p-3">{warning}</p>}
            {showWelcome ? (
              <ChatGptPlanWelcome onDismiss={finish} />
            ) : (
              <Button onClick={finish}>{t("done")}</Button>
            )}
          </div>
        ) : (
          <>
            <section className="space-y-3">
              <h3 className="font-semibold">{t("signInStep")}</h3>
              <p className="text-sm text-text-muted">{t("signInHelp")}</p>
              {attempt ? (
                <ChatGptSignInButton
                  intent={connectionId ? "continue" : "signin"}
                  href={attempt.authUrl}
                />
              ) : (
                <ChatGptSignInButton
                  intent={connectionId ? "continue" : "signin"}
                  busy={busy}
                  disabled
                />
              )}
            </section>
            <section className="space-y-3">
              <h3 className="font-semibold">{t("callbackStep")}</h3>
              <p id="chatgpt-callback-help" className="text-sm text-text-muted">
                {t("callbackHelp", { redirectUri })}
              </p>
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void complete();
                }}
              >
                <label className="block space-y-2">
                  <span>{t("callbackLabel")}</span>
                  <textarea
                    className="w-full rounded-lg border border-border bg-bg-input p-3 font-mono text-sm"
                    value={callbackUrl}
                    onChange={(event) => setCallbackUrl(event.target.value)}
                    placeholder={redirectUri + "?code=…&state=…&client_id=…"}
                    aria-describedby="chatgpt-callback-help"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    maxLength={16384}
                    rows={4}
                    disabled={!attempt || busy}
                  />
                </label>
                <Button
                  type="submit"
                  disabled={!attempt || busy || !callbackUrl.trim()}
                  loading={busy && !!attempt}
                >
                  {t("complete")}
                </Button>
              </form>
              <p className="text-sm text-text-muted">{t("expires")}</p>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  setCallbackUrl("");
                  setAttempt(null);
                  void start();
                }}
              >
                {t("startOver")}
              </Button>
            </section>
            {error && (
              <p role="alert" className="rounded-lg border border-red-500 p-3 text-red-400">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

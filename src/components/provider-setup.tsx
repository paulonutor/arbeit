import { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ProviderMark } from "./brand";
import { request } from "@/lib/client";
import type { ProviderStatus } from "@/lib/types";

function summary(status: ProviderStatus) {
  if (!status.installed) return "Not installed";
  const version = status.version ? ` ${status.version}` : "";
  if (status.authenticated === false)
    return `Installed${version} · Not signed in`;
  if (status.authenticated)
    return `Installed${version} · Signed in${status.authMethod ? ` (${status.authMethod})` : ""}`;
  return `Installed${version} · Sign-in state unknown`;
}

/**
 * Installs provider CLIs into Arbeit's data directory and drives their own
 * sign-in flow. Credentials stay with the provider CLI; Arbeit never sees them.
 */
export function ProviderSetup({ selected }: { selected?: string }) {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const data = await request<{ providers: ProviderStatus[] }>(
      "/api/providers",
    );
    setProviders(data.providers);
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  const running = providers?.some((p) => p.job?.state === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(
      () => void load().catch((e) => setError(e.message)),
      1500,
    );
    return () => clearInterval(timer);
  }, [running, load]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const act = async (
    id: string,
    action: "install" | "login" | "cancel" | "code",
    code?: string,
  ) => {
    setError("");
    try {
      await request(`/api/providers/${id}`, { action, code });
      if (action === "code") setCodes((value) => ({ ...value, [id]: "" }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    }
  };
  return (
    <section className="provider-setup" aria-label="Coding agents">
      <h3>Coding agents</h3>
      <p className="field-note">
        Arbeit installs each CLI into its own data directory and starts the
        provider&apos;s official sign-in. Credentials are handled by the CLI and
        never stored by Arbeit.
      </p>
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      {providers?.map((status) => {
        const job = status.job;
        const busy = job?.state === "running";
        return (
          <div
            className="provider-row"
            key={status.id}
            data-selected={selected === status.id}
          >
            <span className="provider-row-mark">
              <ProviderMark provider={status.id} size={20} />
            </span>
            <span className="provider-row-copy">
              <strong>{status.label}</strong>
              <small>{summary(status)}</small>
              {busy && (
                <small>
                  {job.message}
                  {job.kind === "login" && job.url && (
                    <>
                      {" "}
                      <a
                        href={job.url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        Open sign-in page <ExternalLink size={12} />
                      </a>
                    </>
                  )}
                </small>
              )}
              {busy && job.awaitingCode && (
                <form
                  className="provider-code"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(status.id, "code", codes[status.id] ?? "");
                  }}
                >
                  <Input
                    value={codes[status.id] ?? ""}
                    onChange={(event) =>
                      setCodes({ ...codes, [status.id]: event.target.value })
                    }
                    placeholder="Paste the code shown after signing in"
                    aria-label="Sign-in code"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={500}
                  />
                  <Button type="submit" size="sm">
                    Submit code
                  </Button>
                </form>
              )}
              {!busy && job?.state === "failed" && (
                <small className="provider-row-error">
                  {job.kind === "install" ? "Install" : "Sign-in"} failed
                  {job.message ? `: ${job.message}` : "."}
                </small>
              )}
            </span>
            <span className="provider-row-actions">
              {busy ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void act(status.id, "cancel")}
                >
                  Cancel
                </Button>
              ) : !status.installed ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={!status.installSupported}
                  title={
                    status.installSupported
                      ? `Runs npm install for ${status.package}`
                      : `Install manually: npm install -g ${status.package}`
                  }
                  onClick={() => void act(status.id, "install")}
                >
                  Install
                </Button>
              ) : status.authenticated === true ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void act(status.id, "login")}
                >
                  Sign in again
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void act(status.id, "login")}
                >
                  Sign in
                </Button>
              )}
            </span>
          </div>
        );
      })}
    </section>
  );
}

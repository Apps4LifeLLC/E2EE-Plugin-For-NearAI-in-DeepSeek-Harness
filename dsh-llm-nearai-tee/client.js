/**
 * Client half of dsh-llm-nearai-tee: a small verification badge in the
 * composer dock, beside the shipped activity and usage pills.
 *
 * It reads only shipped client state — the session's model-selection
 * projection, the session running flag, and the chat node kind — so it needs
 * no host-to-client channel. The host adapter never yields a successful
 * `finish` chunk before `verifyResponse` reports `provider_tee`, so a
 * completed turn on the `nearai-e2ee` route is a verified turn.
 */
window.__ModuleLoader__.load({
  id: "dsh-llm-nearai-tee",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const NS = "nearai-e2ee";
    const PROVIDER = "nearai-e2ee";

    const TEXT = {
      ready: "E2EE · ready",
      pending: "E2EE · verifying…",
      verified: "E2EE · verified",
      failed: "E2EE · not verified",
    };

    const TITLES = {
      ready: "This session is on the NEAR AI E2EE route. The badge turns to “verified” after the response signature is checked.",
      pending: "The response is streaming. Tool calls stay withheld until the model TEE signature is verified.",
      verified: "The last completed response carried a verified provider_tee signature.",
      failed: "The last turn did not complete verification. No tool calls were released.",
    };

    const COLORS = {
      ready: "var(--dsw-alias-label-secondary)",
      pending: "var(--dsw-alias-state-warn-primary)",
      verified: "var(--dsw-alias-state-success-primary)",
      failed: "var(--dsw-alias-state-error-primary)",
    };

    function Shield({ color }) {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 13,
          height: 13,
          "aria-hidden": true,
          style: { display: "block", flex: "none", color },
        },
        h("path", {
          d: "M8 1.5 3 3.3v4.1c0 3.2 2.1 5.8 5 6.7 2.9-.9 5-3.5 5-6.7V3.3L8 1.5Z",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinejoin: "round",
        }),
        h("path", {
          d: "M5.9 8.1 7.3 9.5l3-3",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }

    function E2eeBadge({ useProjection, useSession, useChat, t }) {
      const selection = useProjection("modelSelection");
      const running = useSession((snapshot) => snapshot.running);
      const lastKind = useChat((snapshot) => {
        const order = snapshot.order;
        const key = order[order.length - 1];
        return key === undefined ? undefined : snapshot.nodes.get(key)?.kind;
      });
      const hasNodes = useChat((snapshot) => snapshot.order.length > 0);

      const selected = selection?.next ?? selection?.current;
      if (selected?.provider !== PROVIDER) return null;

      const status = running
        ? "pending"
        : lastKind === "turn-error"
          ? "failed"
          : hasNodes
            ? "verified"
            : "ready";

      return h(
        "div",
        {
          "data-nearai-e2ee-badge": status,
          role: "status",
          "aria-live": "polite",
          title: t === undefined ? TITLES[status] : t("e2ee.title." + status),
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "2px 8px",
            borderRadius: 999,
            border: "1px solid var(--dsw-alias-border-l1)",
            background: "var(--dsw-alias-bg-layer-1)",
            color: COLORS[status],
            fontSize: 12,
            lineHeight: "16px",
            whiteSpace: "nowrap",
          },
        },
        h(Shield, { color: COLORS[status] }),
        h("span", null, t === undefined ? TEXT[status] : t("e2ee." + status)),
      );
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() =>
          ctx.locale.register(NS, {
            en: {
              "e2ee.ready": TEXT.ready,
              "e2ee.pending": TEXT.pending,
              "e2ee.verified": TEXT.verified,
              "e2ee.failed": TEXT.failed,
              "e2ee.title.ready": TITLES.ready,
              "e2ee.title.pending": TITLES.pending,
              "e2ee.title.verified": TITLES.verified,
              "e2ee.title.failed": TITLES.failed,
            },
          }),
        );
        ctx.slots.inject("conversation.composer.dock", () =>
          ctx.slots.register(
            {
              name: "conversation.composer.dock",
              id: "nearai-e2ee",
              order: 2,
              locale: NS,
            },
            E2eeBadge,
          ),
        );
      },
    };
  },
});

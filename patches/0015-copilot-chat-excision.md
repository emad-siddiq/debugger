# 0015 — Copilot chat excision: the entitlement stack goes, the chat UI stays

- **Layer:** 3 (core patch — three files) + layer 1 (`product.json`, unledgered by rule)
- **Task:** WO-80 §S1 (the chat-excision task deferred since STRIP.md §"defaultChatAgent")
- **Upstream files touched:** `src/vs/workbench/services/accounts/browser/defaultAccount.ts`,
  `src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts`,
  `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts`
- **Size:** 29 insertions / 4 deletions across 3 files
- **Last verified against:** upstream 1.128.0

## Why

`product.json`'s `defaultChatAgent` block was the last Copilot coupling: GitHub
extension ids, entitlement/token/managed-settings URLs, sign-in provider config.
STRIP.md deferred its removal as "load-bearing — core services crash if it is
absent", and that is exactly what it is: `productService.defaultChatAgent` is
typed **non-optional** (`base/common/product.ts`), so upstream dereferences it
without guards in three boot-path places. WO-80 replaces the Copilot backend
with an extension-registered participant (`burrow-chat`), so the block goes and
the three crash sites get the guards upstream never needed.

Removing the block (not repointing it) is what kills the machinery: with
`defaultChatAgent === undefined`, `ChatEntitlementService` bails before creating
its context/requests (`chatEntitlementService.ts` — "we need a default chat
agent configured going forward from here"), which turns all six
`chatSetup/` files, the setup dialog, the title-bar Sign In button, and the
Accounts-menu entry into dead code with no diff of their own. A repointed block
would have kept every one of them alive, aimed at an extension that cannot
satisfy GitHub entitlement checks.

## What

1. **`defaultAccount.ts`** — `toDefaultAccountConfig()` accepts
   `IDefaultChatAgent | undefined` and returns a neutral config (no preferred
   extensions, empty provider ids, empty URLs) when absent. Both construction
   sites (`DefaultAccountService` in `desktop.main.ts`, and
   `DefaultAccountProviderContribution` at BlockStartup) flow through it. An
   empty provider id is never "available", and `getEntitlements()` already
   early-returns on a falsy URL — so no account resolution, no entitlement
   fetch, no 1-hour poll can start.

2. **`onboardingVariationA.ts`** — the module-scope
   `assertDefined(product.defaultChatAgent, …)` threw during module evaluation,
   taking the whole workbench down. It is now a plain nullable read, and
   `show()` fires `onDidDismiss` and returns when there is no agent — the wizard
   is a Copilot/Google/Apple sign-in flow with nothing to sign in to. The import
   must survive because `startupPage.ts` constructor-injects
   `IOnboardingService`; deleting the contribution would break DI at boot.

3. **`chat.shared.contribution.ts`** — `ChatStatusBarEntry` registration
   commented out (with its import). It renders "$(copilot) Sign In" whenever
   setup is not hidden, and its dashboard (`chatStatusDashboard.ts`) dereferences
   `defaultChatAgent.*` unguarded in seven places. Burrow's chat status story
   belongs to `burrow-chat`, not to a Copilot quota dashboard.

Not touched, deliberately: `agentSessionsWelcome.ts` guards its own derefs
(`?.` + early return); `chatQuotaNotification`, `pluginAutoUpdate`,
`claudePluginRecommendations` fire only on user action or with installed
plugins; `chatParticipant.contribution.ts` needs no change — an
extension-contributed default participant (`isDefault` + the
`defaultChatParticipant` proposal, held by built-in `burrow-chat` via its own
manifest) already wins `getDefaultAgent()` resolution over any core agent.

## Rebase notes

- If upstream makes `IProductService.defaultChatAgent` optional (it should),
  patch 1 collapses to nothing.
- Watch `chatEntitlementService.ts` for the `if (!productService.defaultChatAgent) return;`
  guard — this patch depends on it staying ahead of context/requests creation.
- `ChatStatusBarEntry` may grow non-Copilot duties upstream; if so, prefer a
  ctor guard on `defaultChatAgent` over the registration comment.

## Red case

Demonstrated before the fix: deleting `defaultChatAgent` with stock sources
throws `Onboarding requires a default chat agent product configuration` at
module load (workbench dead), and `toDefaultAccountConfig` throws reading
`.chatExtensionId` of `undefined` from `desktop.main.ts`. Both were reproduced
in the dev build before the guards were written, and the boot check in WO-80's
report is the green case.

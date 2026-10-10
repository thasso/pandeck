# Assembled prompt sizes

Generated — never edit by hand. Rewrite it and review the delta with:

    pnpm --filter @assistant/server test -u src/promptBudgets.test.ts

All numbers are characters, measured against this checkout's
`config/prompts` at the normalized working directory `/repo`
and with every conditional prompt section ON — the worst case over
conditions, at a normalized path. pi's own install directory is
normalized to `/pi` for the same reason, so a CI container
and a developer checkout measure the same commit alike. The enforced
ceilings live in `config/prompt-budgets.json`; this file records the
sizes only.

| Persona | Harness | System prompt | Eager tools | First request |
| --- | --- | ---: | ---: | ---: |
| assistant | pi | 6,208 | 10,108 | 16,316 |
| assistant | claude | 6,188 | 9,405 | 15,593 |
| personal-assistant | pi | 5,438 | 10,108 | 15,546 |
| personal-assistant | claude | 5,418 | 9,405 | 14,823 |
| workshop | pi | 13,025 | 19,886 | 32,911 |
| workshop | claude | 6,892 | 11,368 | 18,260 |
| workflow-coordinator | pi | 3,386 | 2,232 | 5,618 |
| workflow-coordinator | claude | 3,366 | 1,475 | 4,841 |
| developer | pi | 13,459 | 19,399 | 32,858 |
| developer | claude | 7,326 | 10,872 | 18,198 |

## assistant — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 20 |
| `harness-base:pi-docs` | prompt | no | 0 |
| `pi-tool-list:builtin` | prompt | yes | 0 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 0 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:assistant` | prompt | yes | 1,137 |
| `integration:slack` | prompt | yes | 1,146 |
| `integration:google` | prompt | yes | 327 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,487 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | yes | 0 |
| `assembly-overhead` | prompt | yes | 14 |
| `tools:eager:names` | tools | yes | 112 |
| `tools:eager:descriptions` | tools | yes | 2,035 |
| `tools:eager:schemas` | tools | yes | 7,961 |
| `tools:eager:harness-builtin` | tools | yes | 0 |
| `tools:deferred:universe` | tools | no | 130,870 |

## assistant — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:assistant` | prompt | yes | 1,137 |
| `integration:slack` | prompt | yes | 1,146 |
| `integration:google` | prompt | yes | 327 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,487 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | no | 0 |
| `assembly-overhead` | prompt | yes | 14 |
| `tools:eager:names` | tools | yes | 174 |
| `tools:eager:descriptions` | tools | yes | 1,663 |
| `tools:eager:schemas` | tools | yes | 7,568 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 131,680 |

## personal-assistant — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 20 |
| `harness-base:pi-docs` | prompt | no | 0 |
| `pi-tool-list:builtin` | prompt | yes | 0 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 0 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:personal-assistant` | prompt | yes | 1,184 |
| `integration:tempo` | prompt | yes | 224 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,778 |
| `profile-suffix` | prompt | yes | 107 |
| `project-context` | prompt | yes | 0 |
| `assembly-overhead` | prompt | yes | 48 |
| `tools:eager:names` | tools | yes | 112 |
| `tools:eager:descriptions` | tools | yes | 2,035 |
| `tools:eager:schemas` | tools | yes | 7,961 |
| `tools:eager:harness-builtin` | tools | yes | 0 |
| `tools:deferred:universe` | tools | no | 135,235 |

## personal-assistant — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:personal-assistant` | prompt | yes | 1,184 |
| `integration:tempo` | prompt | yes | 224 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,778 |
| `profile-suffix` | prompt | yes | 107 |
| `project-context` | prompt | no | 0 |
| `assembly-overhead` | prompt | yes | 48 |
| `tools:eager:names` | tools | yes | 174 |
| `tools:eager:descriptions` | tools | yes | 1,663 |
| `tools:eager:schemas` | tools | yes | 7,568 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 136,099 |

## workshop — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 1,447 |
| `harness-base:pi-docs` | prompt | no | 1,017 |
| `pi-tool-list:builtin` | prompt | yes | 283 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 609 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:workshop` | prompt | yes | 3,404 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | yes | 3,769 |
| `assembly-overhead` | prompt | yes | 35 |
| `tools:eager:names` | tools | yes | 214 |
| `tools:eager:descriptions` | tools | yes | 5,836 |
| `tools:eager:schemas` | tools | yes | 10,253 |
| `tools:eager:harness-builtin` | tools | yes | 3,583 |
| `tools:deferred:universe` | tools | no | 160,842 |

## workshop — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:workshop` | prompt | yes | 3,404 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | no | 3,613 |
| `assembly-overhead` | prompt | yes | 10 |
| `tools:eager:names` | tools | yes | 310 |
| `tools:eager:descriptions` | tools | yes | 2,342 |
| `tools:eager:schemas` | tools | yes | 8,716 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 162,012 |

## workflow-coordinator — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 20 |
| `harness-base:pi-docs` | prompt | no | 0 |
| `pi-tool-list:builtin` | prompt | yes | 0 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 0 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:workflow-coordinator` | prompt | yes | 3,366 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | yes | 0 |
| `assembly-overhead` | prompt | yes | 0 |
| `tools:eager:names` | tools | yes | 46 |
| `tools:eager:descriptions` | tools | yes | 1,155 |
| `tools:eager:schemas` | tools | yes | 1,031 |
| `tools:eager:harness-builtin` | tools | yes | 0 |
| `tools:deferred:universe` | tools | no | 2,925 |

## workflow-coordinator — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:workflow-coordinator` | prompt | yes | 3,366 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | no | 0 |
| `assembly-overhead` | prompt | yes | 0 |
| `tools:eager:names` | tools | yes | 54 |
| `tools:eager:descriptions` | tools | yes | 783 |
| `tools:eager:schemas` | tools | yes | 638 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 2,943 |

## developer — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 1,447 |
| `harness-base:pi-docs` | prompt | no | 1,017 |
| `pi-tool-list:builtin` | prompt | yes | 283 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 609 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:developer` | prompt | yes | 3,838 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | yes | 3,769 |
| `assembly-overhead` | prompt | yes | 35 |
| `tools:eager:names` | tools | yes | 187 |
| `tools:eager:descriptions` | tools | yes | 5,662 |
| `tools:eager:schemas` | tools | yes | 9,967 |
| `tools:eager:harness-builtin` | tools | yes | 3,583 |
| `tools:deferred:universe` | tools | no | 159,659 |

## developer — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:developer` | prompt | yes | 3,838 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | no | 3,613 |
| `assembly-overhead` | prompt | yes | 10 |
| `tools:eager:names` | tools | yes | 274 |
| `tools:eager:descriptions` | tools | yes | 2,168 |
| `tools:eager:schemas` | tools | yes | 8,430 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 160,820 |

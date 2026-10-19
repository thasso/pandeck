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
| assistant | pi | 6,208 | 10,698 | 16,906 |
| assistant | claude | 6,188 | 9,995 | 16,183 |
| personal-assistant | pi | 5,542 | 18,558 | 24,100 |
| personal-assistant | claude | 5,522 | 9,995 | 15,517 |
| workshop | pi | 13,145 | 20,476 | 33,621 |
| workshop | claude | 6,892 | 11,958 | 18,850 |
| workflow-coordinator | pi | 3,386 | 2,232 | 5,618 |
| workflow-coordinator | claude | 3,366 | 1,475 | 4,841 |
| developer | pi | 13,590 | 19,989 | 33,579 |
| developer | claude | 7,337 | 11,462 | 18,799 |

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
| `tools:eager:descriptions` | tools | yes | 2,076 |
| `tools:eager:schemas` | tools | yes | 8,510 |
| `tools:eager:harness-builtin` | tools | yes | 0 |
| `tools:deferred:universe` | tools | no | 147,317 |

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
| `tools:eager:descriptions` | tools | yes | 1,704 |
| `tools:eager:schemas` | tools | yes | 8,117 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 148,217 |

## personal-assistant — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 20 |
| `harness-base:pi-docs` | prompt | no | 0 |
| `pi-tool-list:builtin` | prompt | yes | 0 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 0 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:personal-assistant` | prompt | yes | 1,288 |
| `integration:tempo` | prompt | yes | 224 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,778 |
| `profile-suffix` | prompt | yes | 107 |
| `project-context` | prompt | yes | 0 |
| `assembly-overhead` | prompt | yes | 48 |
| `tools:eager:names` | tools | yes | 123 |
| `tools:eager:descriptions` | tools | yes | 5,198 |
| `tools:eager:schemas` | tools | yes | 9,654 |
| `tools:eager:harness-builtin` | tools | yes | 3,583 |
| `tools:deferred:universe` | tools | no | 155,829 |

## personal-assistant — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:personal-assistant` | prompt | yes | 1,288 |
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
| `tools:eager:descriptions` | tools | yes | 1,704 |
| `tools:eager:schemas` | tools | yes | 8,117 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 156,819 |

## workshop — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 1,567 |
| `harness-base:pi-docs` | prompt | no | 1,137 |
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
| `tools:eager:descriptions` | tools | yes | 5,877 |
| `tools:eager:schemas` | tools | yes | 10,802 |
| `tools:eager:harness-builtin` | tools | yes | 3,583 |
| `tools:deferred:universe` | tools | no | 180,880 |

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
| `tools:eager:descriptions` | tools | yes | 2,383 |
| `tools:eager:schemas` | tools | yes | 9,265 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 182,158 |

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
| `tools:deferred:universe` | tools | no | 2,896 |

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
| `tools:deferred:universe` | tools | no | 2,914 |

## developer — pi

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | yes | 1,567 |
| `harness-base:pi-docs` | prompt | no | 1,137 |
| `pi-tool-list:builtin` | prompt | yes | 283 |
| `pi-tool-list:app-eager` | prompt | yes | 0 |
| `pi-guidelines:builtin` | prompt | yes | 609 |
| `pi-guidelines:app-eager` | prompt | yes | 0 |
| `persona:developer` | prompt | yes | 3,849 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | yes | 3,769 |
| `assembly-overhead` | prompt | yes | 35 |
| `tools:eager:names` | tools | yes | 187 |
| `tools:eager:descriptions` | tools | yes | 5,703 |
| `tools:eager:schemas` | tools | yes | 10,516 |
| `tools:eager:harness-builtin` | tools | yes | 3,583 |
| `tools:deferred:universe` | tools | no | 182,040 |

## developer — claude

| Layer | Section | Counted | Chars |
| --- | --- | --- | ---: |
| `harness-base` | prompt | no | 0 |
| `persona:developer` | prompt | yes | 3,849 |
| `project-registry` | prompt | yes | 413 |
| `chat-files` | prompt | yes | 860 |
| `chat-math` | prompt | yes | 234 |
| `kb-guidance` | prompt | yes | 570 |
| `memory-guidance` | prompt | yes | 1,401 |
| `profile-suffix` | prompt | yes | 0 |
| `project-context` | prompt | no | 3,613 |
| `assembly-overhead` | prompt | yes | 10 |
| `tools:eager:names` | tools | yes | 274 |
| `tools:eager:descriptions` | tools | yes | 2,209 |
| `tools:eager:schemas` | tools | yes | 8,979 |
| `tools:eager:harness-builtin` | tools | no | 0 |
| `tools:deferred:universe` | tools | no | 183,327 |

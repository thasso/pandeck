{
  description = "Pandeck: Bun/WebSocket server + React web UI";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      # devbox is x86_64-linux. The app package is Linux-only, like its Bun
      # bundle; darwin keeps the stt-model packages for local development.
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Speech-to-text model catalog, read ONCE here and shared by the
      # `stt-model-<id>` packages below, which may not hardcode a model id:
      # adding one is a single edit to config/stt-models.json. The NixOS module
      # does NOT read it — dictation is an optional host capability there, so it
      # deploys no weights and only takes a directory path.
      sttCatalog = (builtins.fromJSON (builtins.readFile ./config/stt-models.json)).models;
    in {
      packages = forAllSystems (pkgs:
        let
          nodejs = pkgs.nodejs_24;
          # pnpm's dependency fetch step is more stable on Darwin with Node 22.
          # The build's other Node steps (the pnpm hooks, the web build) run on
          # Node 24; the packaged server runs on Bun and ships no Node at all.
          pnpm = pkgs.pnpm_11.override { nodejs-slim = pkgs.nodejs-slim_22; };

          # Which optional platform packages pnpm installs: the Linux systems
          # above, on glibc (nixpkgs' Linux stdenv). Named explicitly, never
          # "current", so the dependency FOD's hash does not depend on the host
          # that fetches it, and the offline install selects from the same set.
          pnpmPlatformFlags = [ "--os=linux" "--cpu=x64" "--cpu=arm64" "--libc=glibc" ];

          cleanSrc = pkgs.nix-gitignore.gitignoreSource [ ] ./.;

          # The production package: the pinned Bun runtime, one esbuild-bundled
          # server module, and explicit runtime assets
          # (docs/deployment.md#bun-package). Linux-only.
          personal-assistant = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "personal-assistant";
            version = "0.53.0";

            src = cleanSrc;

            # Which commit this package was built from, for the About surfaces
            # (Settings -> About, and the desktop app's About panel). `cleanSrc`
            # is a gitignore-filtered copy with no `.git`, so neither the web
            # build nor the server can ask git: the flake is the only thing that
            # knows, and it passes the answer in through the environment that
            # `app/server/src/buildInfo.ts` reads — during the build, so the web
            # bundle carries it, and through the wrapper below, so the server
            # process does. Empty for a dirty tree, where there is no committed
            # revision to name; an empty value is read as "unknown", never as a
            # commit.
            ASSISTANT_BUILD_COMMIT = self.rev or "";

            pnpmDeps = pkgs.stdenvNoCC.mkDerivation {
              name = "${finalAttrs.pname}-pnpm-deps";
              inherit (finalAttrs) src;

              nativeBuildInputs = [
                pnpm
                pkgs.cacert
                pkgs.jq
                pkgs.moreutils
                pkgs.pnpm-fixup-state-db
                pkgs.sqlite
                pkgs.writableTmpDirAsHomeHook
                pkgs.zstd
              ];

              impureEnvVars = pkgs.lib.fetchers.proxyImpureEnvVars ++ [ "NIX_NPM_REGISTRY" ];

              installPhase = ''
                runHook preInstall

                mkdir $out
                storePath=$(mktemp -d)

                pnpmVersion=$(pnpm --version)
                echo "Fetching pnpm store with pnpm $pnpmVersion"

                export CI=true
                export pnpm_config_pm_on_fail=ignore
                export pnpm_config_side_effects_cache=false
                export pnpm_config_update_notifier=false
                export pnpm_config_trust_lockfile=true

                pnpm config set store-dir $storePath

                pnpm install \
                  ${pkgs.lib.escapeShellArgs pnpmPlatformFlags} \
                  --ignore-scripts \
                  --frozen-lockfile \
                  --registry="''${NIX_NPM_REGISTRY:-https://registry.npmjs.org/}"

                echo 4 > $out/.fetcher-version

                rm -rf $storePath/{v3,v10,v11}/tmp
                for f in $(find $storePath -name "*.json"); do
                  jq --sort-keys "del(.. | .checkedAt?)" $f | sponge $f
                done

                if [ -f "$storePath/v11/index.db" ]; then
                  pnpm-fixup-state-db "$storePath/v11"
                  sqlite3 "$storePath/v11/index.db" .dump > "$storePath/v11/index.db.sql"
                  rm "$storePath/v11/index.db"
                fi

                rm -rf $storePath/{v3,v10,v11}/projects

                find $storePath -type f -name "*-exec" -exec chmod 555 {} +
                find $storePath -type f -not -name "*-exec" -exec chmod 444 {} +
                find $storePath -type d -exec chmod 555 {} +

                (
                  cd $storePath
                  tar --sort=name \
                    --mtime="@$SOURCE_DATE_EPOCH" \
                    --owner=0 --group=0 --numeric-owner \
                    --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
                    --zstd -cf $out/pnpm-store.tar.zst .
                )

                runHook postInstall
              '';

              dontConfigure = true;
              dontBuild = true;
              dontFixup = true;
              outputHashMode = "recursive";
              outputHashAlgo = "sha256";
              outputHash = "sha256-8vid2Wy3O4mv987ECvqVMenKPWvyM657WqXwPwLbwyA=";
            };

            # Appended here, not set as `pnpmInstallFlags`: without structured
            # attrs a list reaches the hook as one space-joined argument.
            # pnpmConfigHook's clone-or-copy copies on filesystems without
            # reflinks; the unpacked store and node_modules share the build
            # directory, so hardlinks always work and are faster.
            prePnpmInstall = ''
              pnpmInstallFlags+=(${pkgs.lib.escapeShellArgs pnpmPlatformFlags})
              pnpm config set package-import-method hardlink
            '';

            # The source itself already entered the store. Refuse to build a
            # package from config that contains secret-shaped fields.
            preBuild = ''
              pnpm run check:package-config-secrets
            '';

            # Root "build" script builds the production web bundle.
            pnpmBuildScript = "build";

            # No default fixup: stripping would cut the appended payload off the
            # Bun executables, and the only ELF edits this package needs are the
            # two explicit patchelf calls below.
            dontFixup = true;

            nativeBuildInputs = [
              pkgs.bun
              nodejs
              pnpm
              pkgs.pnpmConfigHook
              pkgs.pnpmBuildHook
              pkgs.makeWrapper
              pkgs.patchelf
            ];

            installPhase = ''
              runHook preInstall

              runtime="$out/libexec/personal-assistant"
              bun scripts/build-bun-server-bundle.mjs "$runtime"

              patchelf --set-rpath \
                "${pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]}" \
                "$runtime/native/watcher.node"
              # The Claude CLI is Bun-compiled and requests the FHS loader
              # (/lib64/ld-linux-*.so.2), which NixOS lacks. Rewrite only its
              # PT_INTERP: --set-rpath corrupts Bun's appended payload
              # (segfault), and the binary needs nothing beyond glibc.
              #
              # Do NOT wrap it in a script that invokes the loader explicitly
              # (`exec ld-linux ... claude.real "$@"`): that makes /proc/self/exe
              # — and so the CLI's process.execPath — the loader. The CLI exports
              # CLAUDE_CODE_EXECPATH=process.execPath to every Bash-tool shell,
              # and its shell snapshot shadows grep/find/rg with functions that
              # re-exec that path as a multi-call binary, so every `grep`/`find`
              # in an agent shell died with exit 127 (Task-315).
              patchelf --set-interpreter \
                "${pkgs.stdenv.cc.bintools.dynamicLinker}" \
                "$runtime/claude/claude"

              makeWrapper "$runtime/personal-assistant-server" \
                "$out/bin/personal-assistant-server" \
                --add-flags "$runtime/server.js" \
                --set NODE_ENV production \
                --set ASSISTANT_RUNTIME_DIR "$runtime" \
                --set ASSISTANT_BUILD_COMMIT "$ASSISTANT_BUILD_COMMIT" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git pkgs.openssh ]}

              runHook postInstall
            '';

            passthru.pnpmDeps = finalAttrs.pnpmDeps;

            # Development and the test suites run on Node; this check is what
            # proves the packaged server under the packaged Bun.
            doInstallCheck = true;
            # The runtime probe drives git through the server's spawn broker.
            nativeInstallCheckInputs = [ pkgs.git ];
            installCheckPhase = ''
              runHook preInstallCheck
              bun scripts/test-bun-server-bundle.mjs \
                "$out/libexec/personal-assistant" \
                "$out/bin/personal-assistant-server"
              for forbiddenSource in "$src" "$PWD"; do
                if grep -R -a -F -l -- "$forbiddenSource" \
                  "$out/libexec/personal-assistant"; then
                  echo "Bun runtime output refers to build source: $forbiddenSource" >&2
                  exit 1
                fi
              done
              "$out/libexec/personal-assistant/claude/claude" --version
              runHook postInstallCheck
            '';

            meta = {
              description = "Pandeck server + web UI, as a Bun executable bundle";
              mainProgram = "personal-assistant-server";
              platforms = pkgs.lib.platforms.linux;
            };
          });
        in
        pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          inherit personal-assistant;
          default = personal-assistant;
        }
        # Speech-to-text model weights, one package per catalog entry
        # (`stt-model-<id>`). The catalog is read from the SAME committed JSON the
        # dev `stt:model` script and the server use, so a URL/hash is never
        # written twice: bumping a model is a one-file edit and this build fails
        # loudly on a stale hash.
        #
        # Deliberately NOT part of the `personal-assistant` closure — CI's
        # nix-build must not pull ~500 MB of weights to validate the app — and
        # deliberately in the Nix store rather than DATA_DIR: immutable,
        # content-addressed, shared by every instance, and absent from the
        # DATA_DIR backups it has no business being in.
        //
        (let
          mkModel = entry: pkgs.stdenvNoCC.mkDerivation {
            pname = "stt-model-${entry.id}";
            version = "1";
            src = pkgs.fetchurl { inherit (entry) url; hash = entry.sha256; };
            sourceRoot = entry.stripPrefix;
            dontBuild = true;
            dontFixup = true;
            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              install -Dm444 ${entry.encoder} ${entry.decoder} ${entry.joiner} ${entry.tokens} -t "$out"
              runHook postInstall
            '';
            meta.description = "sherpa-onnx speech-to-text model: ${entry.label}";
          };
        in builtins.listToAttrs (map (entry: {
          name = "stt-model-${entry.id}";
          value = mkModel entry;
        }) sttCatalog)));

      checks = forAllSystems (pkgs:
        let
          package = self.packages.${pkgs.stdenv.hostPlatform.system}.personal-assistant;
          closure = pkgs.closureInfo { rootPaths = [ package ]; };
          previewSystem = nixpkgs.lib.nixosSystem {
            inherit (pkgs.stdenv.hostPlatform) system;
            modules = [
              self.nixosModules.default
              {
                services.personal-assistant = {
                  enable = true;
                  user = "alice";
                  tokenFile = "/run/secrets/production-app";
                  publicBaseUrl = "https://production.example.invalid";
                  apnsCredentialFile = "/run/secrets/production-apns";
                  settings.jira.host = "example.atlassian.net";
                  extraEnvironment.PRODUCTION_SECRET_SENTINEL = "must-not-reach-preview";
                  memory = {
                    max = "36G";
                    swapMax = "8G";
                  };
                  prDeployments = {
                    enable = true;
                    memory.max = "8G";
                    domain = "preview.example.invalid";
                    repoUrl = "https://example.invalid/personal-assistant.git";
                    stateDir = "/var/lib/personal-assistant-previews";
                    credentialEnvironmentFile = "/run/secrets/personal-assistant-preview-%i";
                  };
                };
              }
            ];
          };
          productionUnit = previewSystem.config.systemd.services.personal-assistant;
          previewUnit = previewSystem.config.systemd.services."pa-pr@";
          previewDeployExec =
            previewSystem.config.systemd.services."pa-pr-deploy@".serviceConfig.ExecStart;
          previewOrchestrator = pkgs.lib.removeSuffix "/bin/pa-pr deploy %i" previewDeployExec;
          previewGuardExec = previewUnit.serviceConfig.ExecStartPre;
          previewGuard = pkgs.lib.removeSuffix
            " /var/lib/personal-assistant-previews %i"
            previewGuardExec;
          # The rendered unit files, without their store-path context: grepping
          # them must not build the app package they name.
          unitText = name: pkgs.writeText name (builtins.unsafeDiscardStringContext
            previewSystem.config.systemd.units.${name}.text);
        in pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          # The module's default package is this one, so production runs the
          # closure checked here.
          personal-assistant-closure =
            assert productionUnit.serviceConfig.ExecStart == pkgs.lib.getExe package;
            pkgs.runCommand "personal-assistant-closure" { } ''
              paths=$(cat ${closure}/store-paths)
              if printf '%s\n' "$paths" | grep -E '/[^/]*(nodejs|tsx|node_modules)[^/]*$'; then
                echo "Package closure contains Node, tsx, or node_modules" >&2
                exit 1
              fi
              if printf '%s\n' "$paths" | grep -E '/[^/]*-source$'; then
                echo "Package closure contains a source derivation" >&2
                exit 1
              fi
              printf '%s\n' "$paths" | grep -q '/[^/]*git-'
              printf '%s\n' "$paths" | grep -q '/[^/]*openssh-'
              test -x ${package}/bin/personal-assistant-server
              mkdir "$out"
            '';

          personal-assistant-preview-isolation =
            assert productionUnit.serviceConfig.EnvironmentFile == "/run/secrets/production-app";
            assert previewUnit.serviceConfig.EnvironmentFile == [
              "/var/lib/personal-assistant-previews/%i/env"
              "/run/secrets/personal-assistant-preview-%i"
            ];
            assert !(previewUnit.environment ? PRODUCTION_SECRET_SENTINEL);
            assert !(previewUnit.environment ? ASSISTANT_PUBLIC_BASE_URL);
            assert !(previewUnit.environment ? APNS_CREDENTIAL_FILE);
            assert productionUnit.environment.ASSISTANT_PUBLIC_BASE_URL == "https://production.example.invalid";
            assert productionUnit.environment.APNS_CREDENTIAL_FILE == "/run/secrets/production-apns";
            assert builtins.fromJSON (builtins.readFile productionUnit.environment.ASSISTANT_CONFIG)
              == { jira.host = "example.atlassian.net"; };
            assert previewUnit.environment.ASSISTANT_CONFIG == productionUnit.environment.ASSISTANT_CONFIG;
            assert previewUnit.environment.HOME == "/var/lib/personal-assistant-previews/%i/home";
            assert previewUnit.environment.XDG_CONFIG_HOME == "/var/lib/personal-assistant-previews/%i/home/.config";
            assert previewGuardExec == "${previewGuard} /var/lib/personal-assistant-previews %i";
            pkgs.runCommand "personal-assistant-preview-isolation" { } ''
              script=${previewOrchestrator}/bin/pa-pr
              guard=${previewGuard}
              grep -Fq 'PREVIEW_STATE_VERSION=1' "$script"
              grep -Fq 'refusing to use it' "$script"
              grep -Fq 'systemctl stop "pa-pr@$num.service"' "$script"
              grep -Fq 'Provisioning empty preview state' "$script"
              if grep -Fq '.backup' "$script" || grep -Fq 'cp -a' "$script"; then
                echo "Preview orchestration still copies production state" >&2
                exit 1
              fi

              state="$TMPDIR/previews"
              mkdir -p "$state/7/data" "$state/7/home"
              touch "$state/7/data/preserved"
              if "$guard" "$state" 7; then
                echo "Direct preview start accepted unmarked legacy state" >&2
                exit 1
              fi
              test -f "$state/7/data/preserved"
              printf '1\n' > "$state/7/.preview-state-version"
              "$guard" "$state" 7
              rm -rf "$state/7/home"
              if "$guard" "$state" 7; then
                echo "Direct preview start accepted incomplete isolated state" >&2
                exit 1
              fi
              test -f "$state/7/data/preserved"
              mkdir "$out"
            '';

          personal-assistant-oom-policy = pkgs.runCommand "personal-assistant-oom-policy" { } ''
            expect() {
              grep -qx "$2" "$1" || { echo "$1 lacks '$2'" >&2; exit 1; }
            }
            refuse() {
              if grep -q "^$2=" "$1"; then echo "$1 sets $2" >&2; exit 1; fi
            }
            production=${unitText "personal-assistant.service"}
            preview=${unitText "pa-pr@.service"}
            for unit in "$production" "$preview"; do
              expect "$unit" 'OOMPolicy=continue'
              expect "$unit" 'OOMScoreAdjust=-900'
              expect "$unit" 'ManagedOOMPreference=avoid'
              refuse "$unit" MemoryHigh
            done
            expect "$production" 'MemoryMax=36G'
            expect "$production" 'MemorySwapMax=8G'
            expect "$preview" 'MemoryMax=8G'
            refuse "$preview" MemorySwapMax
            mkdir "$out"
          '';
        });

      # NixOS module: run the assistant as a user-space systemd service. Consumed
      # by the devbox config in the dotfiles flake. Deploy target is x86_64-linux.
      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.services.personal-assistant;
          pr = cfg.prDeployments;

          # This module's own nixpkgs, NOT the host's. Used only for helper
          # scripts whose store paths land in the unit: built from the host's
          # `pkgs` they would move on every `nix flake update` in the host
          # config, restarting a service that drains agent turns for up to an
          # hour. Anything the AGENT uses comes from the host instead (see
          # servicePath).
          #
          # PRECONDITION, and the one the whole no-churn property rests on: a
          # consumer must NOT set `inputs.personal-assistant.inputs.nixpkgs.follows`.
          # The reflex is to add it to deduplicate closures; here it makes
          # paPkgs == pkgs, so this script AND cfg.package rebuild from the host's
          # nixpkgs and the churn returns silently — the unit changes on every host
          # input update again, with nothing to notice it by.
          paPkgs = nixpkgs.legacyPackages.${pkgs.stdenv.hostPlatform.system};

          # Shared by the production service and every pa-pr@ preview instance so
          # their host-tool PATH never drifts.
          #
          # Deliberately NO pinned toolchain here. The agent's tools are HOST
          # tools: this service exists to run agents on this machine, so they
          # should see the machine's git/bash/coreutils, and the requirements are
          # declared in `config/host-tools.json` and verified once at startup
          # rather than vendored. Two consequences, both accepted: a tool can
          # change under a running agent, and the operator owns keeping the host
          # above the declared floors.
          #
          # `git`/`openssh` are NOT missing — the package wrapper already prefixes
          # its own pinned pair onto PATH (see makeWrapper in the package above).
          # Note the scope: `--prefix PATH` applies to the whole server process
          # environment, which children inherit, so agent shells resolve the
          # vendored pair too. They are the two exceptions to "agent tools are
          # host tools", not just an internal detail of the server's plumbing.
          #
          # Every entry is a hash-free path, so NOTHING here can churn the unit.
          # That is load-bearing rather than incidental — see the note where
          # extraPackages used to be. Add tools via the host's systemPackages or
          # the service user's profile, both of which arrive through these.
          servicePath = [
            "/etc/profiles/per-user/${cfg.user}"
            "/run/current-system/sw"
          ];

          # Base environment for production. Preview units deliberately define
          # their own smaller environment below. In particular, they never inherit
          # cfg.extraEnvironment or the production HOME.
          baseEnv = {
            NODE_ENV = "production";
            ASSISTANT_HOST = cfg.host;
            ASSISTANT_CWD = cfg.workingDir;
            HOME = "/home/${cfg.user}";
          };

          # The type only; rendering below does not use the host's pkgs.
          jsonFormat = pkgs.formats.json { };

          # builtins.toFile rather than a writeText derivation: its path is a
          # function of name and content alone, so a host `nix flake update`
          # cannot move it — and with it the unit. Unlike the rest of the
          # production environment this is shared with previews: it holds only
          # the static, nonsecret metadata every build used to carry in its
          # packaged config/app.json.
          settingsEnv = lib.optionalAttrs (cfg.settings != { }) {
            ASSISTANT_CONFIG = builtins.toFile "personal-assistant-config.json"
              (builtins.toJSON cfg.settings);
          };

          # Mirrors scripts/check-package-config-secrets.mjs: a secret-shaped
          # field NAME anywhere in settings would land in the world-readable store.
          secretSettingPaths = path: value:
            let
              normalized = name: lib.toLower (lib.concatStrings
                (builtins.filter (c: builtins.match "[a-zA-Z0-9]" c != null)
                  (lib.stringToCharacters name)));
              secretShaped = name: builtins.match
                ".*(secrets?|tokens?|passwords?|privatekeys?|cookies?|credentials?|apikeys?)"
                (normalized name) != null;
            in
            if builtins.isAttrs value then
              lib.concatLists (lib.mapAttrsToList
                (name: child:
                  if secretShaped name then [ "${path}.${name}" ]
                  else secretSettingPaths "${path}.${name}" child)
                value)
            else if builtins.isList value then
              lib.concatLists (lib.imap0
                (index: child: secretSettingPaths "${path}[${toString index}]" child)
                value)
            else [ ];

          # Stop sequence: drain, then sweep. Signal the server and wait for it
          # to finish draining active turns (bounded by TimeoutStopSec), then
          # SIGKILL whatever is still in the unit's cgroup. Agent sessions can
          # leave background processes behind (e.g. a dev-server tree with a
          # self-restarting supervisor); with plain KillMode=control-group those
          # survive systemd's SIGTERM and hold the stop — and any deploy waiting
          # on the restart — for the full TimeoutStopSec (1h).
          # paPkgs, not pkgs: this script's store path is baked into the prod
          # unit's ExecStop, so building it from the host's nixpkgs would move the
          # unit on every host input update.
          execStopDrain = paPkgs.writeShellScript "personal-assistant-stop" ''
            if [ -n "''${MAINPID:-}" ]; then
              kill -TERM "$MAINPID" 2>/dev/null || true
              while kill -0 "$MAINPID" 2>/dev/null; do sleep 2; done
            fi
            # The server is gone; anything left in the cgroup is a stray.
            cgroup="/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)"
            if [ -r "$cgroup/cgroup.procs" ]; then
              for pid in $(cat "$cgroup/cgroup.procs"); do
                [ "$pid" = "$$" ] || kill -9 "$pid" 2>/dev/null || true
              done
            fi
          '';

          # OOM policy shared by production and every preview. The unit's cgroup
          # also holds every agent process, so a kernel OOM kill of one of them
          # must not stop the unit (`OOMPolicy=continue`), and the server should
          # be the kernel's last choice: OOMScoreAdjust lowers it, and the
          # server hands its children back 0 (app/server/src/childOomScore.ts),
          # since children inherit the value. oomd kills whole cgroups, i.e. the
          # entire service with every session, so `avoid` asks it to pick
          # anything else first; NixOS's defaults have oomd manage no slice at
          # all. The memory limits are host-specific and unset by default:
          # MemoryMax usually turns a runaway into a cgroup-local OOM that kills
          # it, rather than a global one that endangers the machine. All of it
          # is best effort, not a guarantee; see docs/deployment.md "Service
          # lifecycle and environment".
          oomServiceConfig = memory: {
            OOMPolicy = "continue";
            OOMScoreAdjust = cfg.oomScoreAdjust;
            ManagedOOMPreference = "avoid";
          } // lib.filterAttrs (_: value: value != null) {
            MemoryHigh = memory.high;
            MemoryMax = memory.max;
            MemorySwapMax = memory.swapMax;
          };

          memoryOptions = unit: {
            high = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "32G";
              description = ''
                systemd `MemoryHigh=` for ${unit}. Above it the kernel throttles
                and reclaims the WHOLE cgroup, server included, and never kills:
                a runaway then crawls in reclaim instead of dying. Leave null
                unless you want that; `max` is the containment knob.
              '';
            };
            max = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "36G";
              description = ''
                systemd `MemoryMax=` for ${unit}. Reaching it triggers a
                cgroup-local OOM kill, which normally picks the largest agent
                process (the server is protected) while the unit keeps running.
                Budget it with the rest of the host: production plus concurrent
                previews plus host baseline plus build headroom must fit in RAM,
                or a global OOM can still come first. Null leaves the unit
                unlimited.
              '';
            };
            swapMax = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "8G";
              description = ''
                systemd `MemorySwapMax=` for ${unit}. Without it a runaway can
                push tens of gigabytes into swap, thrashing the host for minutes
                before any OOM kill. Null leaves swap unlimited.
              '';
            };
          };

          previewStateVersion = "1";

          # Every start, including a direct `systemctl start pa-pr@<n>`, must
          # prove the state was created by the isolated preview provisioner. This
          # guard never changes or removes state.
          previewStateGuard = pkgs.writeShellScript "personal-assistant-preview-state-guard" ''
            set -euo pipefail
            state_dir="''${1:-}"
            num="''${2:-}"
            case "$num" in
              "" | *[!0-9]*) echo "preview-state-guard: instance must be numeric" >&2; exit 1;;
            esac

            inst="$state_dir/$num"
            marker="$inst/.preview-state-version"
            version=""
            if [ -f "$marker" ]; then
              IFS= read -r version < "$marker" || true
            fi
            if [ "$version" != ${lib.escapeShellArg previewStateVersion} ]; then
              echo "preview-state-guard: refusing direct start of unmarked or obsolete preview state at $inst" >&2
              echo "Use 'sudo pa-pr deploy $num' for preserve/teardown/reprovision instructions." >&2
              exit 1
            fi
            if [ ! -d "$inst/data" ] || [ ! -d "$inst/home" ]; then
              echo "preview-state-guard: refusing incomplete preview state at $inst" >&2
              exit 1
            fi
          '';

          # Root orchestration script for PR previews. Started as fixed systemd
          # oneshots (pa-pr-deploy@/pa-pr-teardown@) by the CI runner via polkit,
          # and available for manual `sudo pa-pr {deploy,teardown} <n>`.
          paPr = pkgs.writeShellScriptBin "pa-pr" ''
            set -euo pipefail
            # git/gawk/coreutils plus the Caddy coordination tools are
            # pinned; nix, systemctl and caddy reload come from the running system.
            export PATH=${lib.makeBinPath [ pkgs.git pkgs.gawk pkgs.coreutils pkgs.util-linux pkgs.openssl ]}:/run/current-system/sw/bin
            # Deterministic writable HOME for git's safe.directory + nix eval cache.
            export HOME=/root
            git config --global --add safe.directory '*' || true

            STATE_DIR=${lib.escapeShellArg pr.stateDir}
            CADDY_DIR=${lib.escapeShellArg pr.caddyImportDir}
            REPO_URL=${lib.escapeShellArg pr.repoUrl}
            PORT_BASE=${toString pr.portBase}
            DOMAIN=${lib.escapeShellArg pr.domain}
            APP_USER=${lib.escapeShellArg cfg.user}
            APP_CWD=${lib.escapeShellArg cfg.workingDir}

            cmd="''${1:-}"
            num="''${2:-}"

            case "$num" in
              "" | *[!0-9]*) echo "pa-pr: PR number must be numeric, got '$num'" >&2; exit 1;;
            esac

            inst="$STATE_DIR/$num"
            data="$inst/data"
            home="$inst/home"
            state_version="$inst/.preview-state-version"
            PREVIEW_STATE_VERSION=${lib.escapeShellArg previewStateVersion}
            port=$((PORT_BASE + num))
            host="pr-$num.$DOMAIN"
            routes="$CADDY_DIR/routes"
            route="$routes/pr-$num.caddy"
            wildcard_site="$CADDY_DIR/00-pr-wildcard.caddy"
            caddy_lock="$CADDY_DIR/.pa-pr.lock"

            write_route() {
              route_num="$1"
              route_host="pr-$route_num.$DOMAIN"
              route_file="$routes/pr-$route_num.caddy"
              route_tmp="$route_file.tmp.$$"
              printf '@pr%s host %s\nhandle @pr%s {\n\treverse_proxy localhost:%s\n}\n' \
                "$route_num" "$route_host" "$route_num" "$((PORT_BASE + route_num))" > "$route_tmp"
              chmod 0644 "$route_tmp"
              mv -f "$route_tmp" "$route_file"
            }

            ensure_caddy_layout() {
              mkdir -p "$CADDY_DIR" "$routes"
              chmod 0755 "$CADDY_DIR" "$routes"

              # Migrate site blocks written by versions that obtained one
              # certificate per PR. Keeping all discovered routes avoids dropping
              # another running preview when the first new script is deployed.
              for legacy in "$CADDY_DIR"/pr-*.caddy; do
                [ -e "$legacy" ] || continue
                legacy_num="$(basename "$legacy")"
                legacy_num="''${legacy_num#pr-}"
                legacy_num="''${legacy_num%.caddy}"
                case "$legacy_num" in
                  "" | *[!0-9]*) echo "pa-pr: refusing unexpected legacy route '$legacy'" >&2; exit 1;;
                esac
                write_route "$legacy_num"
                rm -f "$legacy"
              done

              wildcard_tmp="$wildcard_site.tmp.$$"
              printf '*.%s {\n\timport %s/*.caddy\n}\n' "$DOMAIN" "$routes" > "$wildcard_tmp"
              chmod 0644 "$wildcard_tmp"
              mv -f "$wildcard_tmp" "$wildcard_site"
            }

            wait_for_wildcard_certificate() {
              echo "Waiting for Caddy wildcard certificate *.$DOMAIN"
              attempts=0
              while [ "$attempts" -lt 144 ]; do
                # Probe a name that never has its own site/certificate; an existing
                # per-PR certificate must not make the wildcard readiness check pass.
                sans=$(printf '\n' | timeout 10 openssl s_client \
                  -connect 127.0.0.1:443 -servername "wildcard-certificate-probe.$DOMAIN" 2>/dev/null \
                  | openssl x509 -noout -ext subjectAltName 2>/dev/null || true)
                if printf '%s\n' "$sans" | grep -Fq "DNS:*.$DOMAIN"; then
                  echo "Caddy wildcard certificate is ready"
                  return 0
                fi
                attempts=$((attempts + 1))
                sleep 5
              done
              echo "pa-pr: timed out waiting for Caddy wildcard certificate *.$DOMAIN" >&2
              return 1
            }

            reload_caddy() {
              # Caddy reloads cancel in-flight ACME jobs. Serialize every preview
              # config mutation and keep the lock until the one-time wildcard
              # certificate bootstrap has completed.
              mkdir -p "$CADDY_DIR"
              (
                flock -x 9
                ensure_caddy_layout
                "$@"
                systemctl reload caddy.service
                wait_for_wildcard_certificate
              ) 9> "$caddy_lock"
            }

            deploy() {
              if [ -e "$inst" ] && ! ${previewStateGuard} "$STATE_DIR" "$num"; then
                systemctl stop "pa-pr@$num.service" 2>/dev/null || true
                cat >&2 <<EOF
pa-pr: preview state already exists at $inst but predates isolated preview credentials; refusing to use it.
The preview service was stopped. Its state was left untouched.
Copy out anything you need, then run 'sudo pa-pr teardown $num' followed by 'sudo pa-pr deploy $num'.
Teardown deletes that preview directory.
EOF
                exit 1
              fi

              echo "Resolving refs/pull/$num/head on $REPO_URL"
              rev=$(git ls-remote "$REPO_URL" "refs/pull/$num/head" | awk '{print $1}')
              [ -n "$rev" ] || { echo "pa-pr: cannot resolve PR $num head" >&2; exit 1; }
              echo "PR $num head = $rev"

              echo "Building personal-assistant at $rev (store cache hit expected)"
              pkg=$(nix build --no-link --print-out-paths \
                "git+$REPO_URL?ref=refs/pull/$num/head&rev=$rev#personal-assistant")

              if [ -e "$inst" ]; then
                echo "Preview state identity is current; preserving it and updating the build only"
              else
                echo "Provisioning empty preview state (no production data or credentials are copied)"
                umask 077
                mkdir -p "$data" "$home/.config" "$home/.local/share" \
                  "$home/.local/state" "$home/.cache"
                printf '%s\n' "$PREVIEW_STATE_VERSION" > "$state_version.tmp.$$"
                mv "$state_version.tmp.$$" "$state_version"
              fi

              umask 077
              {
                printf 'ASSISTANT_PACKAGE=%s\n' "$pkg/bin/personal-assistant-server"
                printf 'ASSISTANT_PORT=%s\n' "$port"
                printf 'DATA_DIR=%s\n' "$data"
                printf 'ASSISTANT_CWD=%s\n' "$APP_CWD"
                printf 'ASSISTANT_ALLOWED_ORIGINS=%s\n' "https://$host"
              } > "$inst/env"
              chown -R "$APP_USER":users "$inst"

              echo "Starting pa-pr@$num on 127.0.0.1:$port"
              systemctl restart "pa-pr@$num.service"

              reload_caddy write_route "$num"
              echo "PR $num live at https://$host"
            }

            teardown() {
              echo "Tearing down PR $num"
              systemctl stop "pa-pr@$num.service" 2>/dev/null || true
              reload_caddy rm -f "$route"
              # Path-guarded delete: never outside stateDir/<n>.
              case "$inst" in
                "$STATE_DIR"/*) rm -rf "$inst";;
                *) echo "pa-pr: refusing to delete '$inst'" >&2; exit 1;;
              esac
              echo "PR $num torn down"
            }

            case "$cmd" in
              deploy) deploy;;
              teardown) teardown;;
              *) echo "usage: pa-pr {deploy|teardown} <pr-number>" >&2; exit 1;;
            esac
          '';
        in {
          options.services.personal-assistant = {
            enable = lib.mkEnableOption "Pandeck server (user-space)";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.personal-assistant;
              defaultText = lib.literalExpression "personal-assistant.packages.\${system}.personal-assistant";
              description = "The assistant package to run.";
            };

            user = lib.mkOption {
              type = lib.types.str;
              example = "alice";
              description = ''
                System user to run as. The service runs in this user's space with
                its real $HOME for local repositories and user-level tooling.
                Agent credentials remain isolated in PA-managed credential profiles
                and are never inherited from ~/.claude or ~/.pi.
              '';
            };

            host = lib.mkOption {
              type = lib.types.str;
              default = "127.0.0.1";
              description = "Bind address. Keep on loopback; Caddy fronts it.";
            };

            port = lib.mkOption {
              type = lib.types.port;
              default = 8787;
              description = "TCP port the server listens on.";
            };

            dataDir = lib.mkOption {
              type = lib.types.str;
              default = "/home/${cfg.user}/.local/share/personal-assistant";
              defaultText = lib.literalExpression ''"/home/''${cfg.user}/.local/share/personal-assistant"'';
              description = "DATA_DIR: all runtime state (SQLite, sessions, KB git, settings, secrets).";
            };

            workingDir = lib.mkOption {
              type = lib.types.str;
              default = "/home/${cfg.user}";
              defaultText = lib.literalExpression ''"/home/''${cfg.user}"'';
              description = "ASSISTANT_CWD: the directory the agent is rooted at.";
            };

            tokenFile = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = ''
                Production-only systemd EnvironmentFile path. The file may
                provide ASSISTANT_TOKEN, ASSISTANT_SLACK_CLIENT_SECRET,
                ASSISTANT_SLACK_APP_TOKEN, ASSISTANT_GOOGLE_OAUTH_CLIENT_SECRET,
                and ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET. Use a runtime path
                written by the host secret manager. Nix puts only the path in the
                unit, never the file contents. When null, the server generates and
                persists a random browser token under dataDir. Preview instances do
                not inherit this file.
              '';
            };

            publicBaseUrl = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "https://assistant.example.net";
              description = "ASSISTANT_PUBLIC_BASE_URL fallback used for generated external callback URLs when forwarded request headers are unavailable.";
            };

            settings = lib.mkOption {
              type = jsonFormat.type;
              default = { };
              example = lib.literalExpression ''
                {
                  jira.host = "example.atlassian.net";
                  google.oauthClientId = "1234-abc.apps.googleusercontent.com";
                  slack = {
                    workspaceHost = "example.slack.com";
                    teamId = "T0123456789";
                    clientId = "1234.5678";
                  };
                }
              '';
              description = ''
                This deployment's static config (the `config/app.json` shape:
                integration hosts, OAuth client ids, Slack workspace), rendered
                to a JSON file in the Nix store and handed to production and PR
                previews as ASSISTANT_CONFIG. It replaces the neutral
                `config/app.json` packaged with the app. The store is
                world-readable, so secret-shaped field names are refused; supply
                secrets through tokenFile. `dataDir` and `publicBaseUrl` have
                their own options and are refused here too.
              '';
            };

            apnsCredentialFile = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "/run/secrets/pa-apns-credential.json";
              description = ''
                APNS_CREDENTIAL_FILE: runtime path to the Apple Push auth key that
                lets the server notify the iOS app while it is closed (e.g. a
                sops-nix secret). This is a string rather than a Nix path so the
                credential cannot be copied into the store by option coercion.
                Shape and setup are in docs/notifications.md. When null the server
                looks under dataDir instead, and simply never pushes if it is
                absent — the app then falls back to raising alerts over its own
                connection while it runs.
              '';
            };

            allowedOrigins = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              example = [ "https://assistant.example.net" ];
              description = "ASSISTANT_ALLOWED_ORIGINS: extra browser origins allowed to call the API.";
            };

            # There is deliberately NO extraPackages option. Putting a host
            # `pkgs` derivation on this service's PATH was the last remaining way
            # to move the unit on an unrelated host update, and every legitimate
            # use is better served by the host's own `environment.systemPackages`
            # or the service user's profile: both reach the service through the
            # hash-free `/run/current-system/sw` and `/etc/profiles/per-user/<user>`
            # entries already on PATH, so they add a tool WITHOUT touching the
            # unit or restarting a service that drains agent turns for an hour.
            # The one case that genuinely needs precedence over the host — the
            # server's own git/openssh — is handled by the package wrapper.

            extraEnvironment = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
              description = ''
                Extra nonsecret production environment variables. Values are
                rendered into the systemd unit and the Nix store. Put credentials
                and tokens in tokenFile instead.
              '';
            };

            oomScoreAdjust = lib.mkOption {
              type = lib.types.ints.between (-999) 1000;
              default = -900;
              description = ''
                systemd `OOMScoreAdjust=` for the production and preview servers.
                The kernel adds this many thousandths of the memory it is
                choosing within to a process's badness, so -900 makes the server
                its last choice in both a global and a cgroup-local OOM. The
                server hands every other process in its unit back 0. -1000
                is excluded: an unkillable server that leaks would stall the unit
                instead of restarting.
              '';
            };

            memory = memoryOptions "the production unit";

            # Dictation is an OPTIONAL HOST CAPABILITY, not a dependency of this
            # module. The operator installs the recognizer
            # (`sherpa-onnx-offline-websocket-server` on the service PATH) and puts
            # model weights somewhere readable; the server discovers both at
            # startup and reports `configured: false` with a specific reason when
            # either is absent, which is what disables the composer's mic button.
            #
            # Consequently this module holds NO recognizer package and NO model
            # package: nothing here can put a ~311 MB binary closure or ~631 MB of
            # weights into the unit, and a host toolchain update cannot move the
            # unit and force a restart. The app still SHIPS the recipe — the
            # `stt-model-<id>` flake packages and `config/stt-models.json` — so
            # `nix build .#stt-model-<id>` remains a hash-verified way to obtain
            # weights; using it is the operator's choice, not this module's.
            speech = {
              modelDir = lib.mkOption {
                type = lib.types.str;
                default = "";
                example = "/mnt/bulk/stt-models/parakeet-tdt-600m-v2-int8";
                description = ''
                  Directory holding the weights of ONE catalogued model, exported as
                  `ASSISTANT_STT_MODEL_DIR`. Empty (the default) leaves dictation to
                  whatever the server can discover on its own, which in production
                  means "disabled".

                  A path rather than a package, so this module never owns weights:
                  where they come from is entirely the host's business.

                  A store path is a fine value, but mind WHICH kind. A
                  fixed-output derivation (a host `fetchzip` of the weights) has a
                  path determined by its name and output hash alone, so it never
                  moves when the host's nixpkgs does. An INPUT-addressed
                  derivation built from the host's `pkgs` moves on every host input
                  update and takes this unit — and a service that drains agent
                  turns for up to an hour — with it. That is the churn this option
                  exists to avoid.

                  The directory must contain the four files the matching
                  `config/stt-models.json` entry names — a partial directory counts
                  as absent rather than being handed to the recognizer, which would
                  fail much later with an opaque error.
                '';
              };

              logFile = lib.mkOption {
                type = lib.types.str;
                default = "/tmp/personal-assistant-stt.log";
                description = ''
                  Recognizer log path. It records connect/disconnect lines only (no
                  transcripts) but appends forever, so it deliberately defaults
                  OUTSIDE dataDir, which is backed up.
                '';
              };
            };

            prDeployments = {
              enable = lib.mkEnableOption ''
                per-PR preview deployments. When on, this module installs a
                `pa-pr@<n>` template service, `pa-pr-deploy@<n>`/`pa-pr-teardown@<n>`
                root oneshots, the `pa-pr` orchestration script, and a polkit rule
                letting `deployUser` start those oneshots. PR instances share the
                production host-tool PATH and Unix user, but start with an empty
                data directory, isolated HOME, and no production environment files.
                The module writes one wildcard Caddy site plus
                per-PR host routes; wildcard DNS and Caddy's DNS-01 issuer remain
                host configuration
              '';

              repoUrl = lib.mkOption {
                type = lib.types.str;
                example = "https://git.example.net/alice/personal-assistant.git";
                description = ''
                  Git URL used to resolve `refs/pull/<n>/head` and build the app at
                  a PR revision. Building at the PR rev is normally a store cache
                  hit from the CI nix-build job on the same host.
                '';
              };

              portBase = lib.mkOption {
                type = lib.types.port;
                default = 8800;
                description = "PR instance <n> listens on portBase + n (loopback; Caddy fronts it).";
              };

              credentialEnvironmentFile = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                example = "/run/secrets/personal-assistant-preview-%i";
                description = ''
                  Optional preview-only systemd EnvironmentFile path for an
                  explicitly provisioned credential identity. It must contain `%i`,
                  which systemd expands to the PR number, so each instance has a
                  distinct file. Null means no external preview credentials. Nix
                  puts only the path in the unit, never its contents.
                '';
              };

              domain = lib.mkOption {
                type = lib.types.str;
                example = "assistant.example.net";
                description = "PR instance <n> is served at pr-<n>.<domain>.";
              };

              stateDir = lib.mkOption {
                type = lib.types.str;
                defaultText = lib.literalExpression ''"/home/''${cfg.user}/pa-pr"'';
                default = "/home/${cfg.user}/pa-pr";
                description = "Root for per-PR state: stateDir/<n>/{data,env}. Deleted on teardown.";
              };

              caddyImportDir = lib.mkOption {
                type = lib.types.str;
                default = "/var/lib/caddy/pr.d";
                description = ''
                  Directory where the deploy script writes one wildcard Caddy site
                  and a `routes/` child containing per-PR host matchers. The host
                  Caddy config must `import` the top-level `*.caddy` glob. Under
                  Caddy's StateDirectory by default so the caddy user can read it.
                '';
              };

              deployUser = lib.mkOption {
                type = lib.types.str;
                default = "gitea-runner";
                description = "User authorized (via polkit) to start the pa-pr-deploy@/pa-pr-teardown@ oneshots.";
              };

              memory = memoryOptions "EACH `pa-pr@<n>` preview instance";
            };
          };

          config = lib.mkIf cfg.enable (lib.mkMerge [
            {
              assertions = [
                {
                  assertion = secretSettingPaths "settings" cfg.settings == [ ];
                  message = "services.personal-assistant.settings must not contain secret-shaped fields (${lib.concatStringsSep ", " (secretSettingPaths "settings" cfg.settings)}); supply secrets through tokenFile";
                }
                {
                  assertion = !(cfg.settings ? dataDir) && !(cfg.settings ? publicBaseUrl);
                  message = "Set services.personal-assistant.dataDir and publicBaseUrl through their own options, not settings";
                }
              ];

              systemd.services.personal-assistant = {
                description = "Pandeck server";
                # Start at boot.
                wantedBy = [ "multi-user.target" ];
                after = [ "network-online.target" ];
                wants = [ "network-online.target" ];

                # HOST PATH ONLY: the user's Nix profile then the system profile,
                # so spawned coding agents see the machine's toolbox without
                # hand-listing it. Entries given as strings get "/bin" (and
                # "/sbin") appended by the option; nonexistent dirs are harmlessly
                # ignored. Requirements are declared in `config/host-tools.json`
                # and checked once at startup.
                #
                # NOTE: a systemd service is NOT a login shell — shell aliases and
                # functions are never inherited, and rc-file-exported env vars are
                # absent. Put nonsecret env in `extraEnvironment` and secrets in
                # the host-managed `tokenFile`. /run/wrappers is intentionally
                # omitted (no setuid
                # sudo for agents); add it here if you want that parity.
                path = servicePath;

                # Drop the coreutils/findutils/gnugrep/gnused/systemd that NixOS
                # appends to every unit (nixos/lib/systemd-lib.nix). They are
                # host-nixpkgs store paths, so they alone would move this unit on
                # any host input update — and the host profiles on `path` already
                # provide all five.
                enableDefaultPath = false;

                environment = baseEnv // {
                  ASSISTANT_PORT = toString cfg.port;
                  DATA_DIR = cfg.dataDir;
                  ASSISTANT_ALLOWED_ORIGINS = lib.concatStringsSep "," cfg.allowedOrigins;
                  # Background `git fetch` for watched repos, so the worktree
                  # surfaces' "behind" counts are current. HERE and not in
                  # baseEnv for the same reason as the dictation vars below:
                  # previews inherit baseEnv AND share this instance's
                  # projectsRoot, so every live preview would be fetching the
                  # very same repositories on its own timer.
                  ASSISTANT_BACKGROUND_FETCH = "1";
                  # Provider-backed PR inventory has the same single-owner
                  # requirement: previews must read their own cold cache rather
                  # than multiply production's Forgejo/GitHub polling.
                  ASSISTANT_BACKGROUND_PR_SYNC = "1";
                  ASSISTANT_STT_LOG = cfg.speech.logFile;
                  # Pin the host-tool contract to the DEPLOYED table. hostTools.ts
                  # otherwise prefers `$CWD/config/host-tools.json`, matching the
                  # stt catalog's lookup — but the two fail in opposite
                  # directions. A shadowing stt catalog can only DISABLE dictation:
                  # loud and self-explaining. A shadowing host-tools.json with a
                  # short or empty `required` list passes VACUOUSLY, quietly
                  # weakening the contract instead of failing it. Costs nothing:
                  # cfg.package is already this unit's ExecStart, so this adds no
                  # store path and no churn, and dev (which sets nothing) keeps the
                  # workspace-first lookup.
                  ASSISTANT_HOST_TOOLS =
                    "${cfg.package}/libexec/personal-assistant/config/host-tools.json";
                }
                // settingsEnv
                # Production-only, like the dictation env below: a preview must
                # neither generate callback URLs on production's origin nor push
                # as production.
                // lib.optionalAttrs (cfg.publicBaseUrl != null) {
                  ASSISTANT_PUBLIC_BASE_URL = cfg.publicBaseUrl;
                }
                // lib.optionalAttrs (cfg.apnsCredentialFile != null) {
                  APNS_CREDENTIAL_FILE = cfg.apnsCredentialFile;
                }
                # Dictation env lives HERE and not in baseEnv on purpose: previews
                # share baseEnv, and each would otherwise be able to warm its own
                # ~2 GB recognizer off the host PATH. See
                # services.personal-assistant.speech.
                // lib.optionalAttrs (cfg.speech.modelDir != "") {
                  ASSISTANT_STT_MODEL_DIR = cfg.speech.modelDir;
                }
                # Hash-free forms of the two variables NixOS injects into EVERY
                # unit via `systemd.globalEnvironment`: LOCALE_ARCHIVE from
                # nixos/modules/config/i18n.nix and TZDIR from
                # nixos/modules/config/locale.nix. Left alone they embed the host's
                # glibc-locales and tzdata store paths, so any host `nix flake update`
                # would move this unit and restart a service that drains agent
                # turns for up to an hour. `systemd.globalEnvironment //
                # def.environment` (nixos/lib/systemd-lib.nix) means a per-service
                # entry wins; these are the same indirections NixOS itself uses for
                # the session environment.
                // {
                  LOCALE_ARCHIVE = "/run/current-system/sw/lib/locale/locale-archive";
                  TZDIR = "/etc/zoneinfo";
                } // cfg.extraEnvironment;

                # Give up instead of looping forever on a failure that restarting
                # cannot fix — a host below the declared `config/host-tools.json`
                # floors, or unusable packaged prompt assets, both of which refuse
                # to serve BEFORE binding. systemd's own default burst of 5 in 10s
                # never trips here, because RestartSec=5 spaces five starts over
                # ~25s and the window keeps resetting. A window comfortably longer
                # than 5*RestartSec turns that into a terminal `failed`, which is
                # visible in `systemctl status` and to the deploy's health check
                # rather than a silent 5-second retry loop in the journal.
                unitConfig = {
                  StartLimitIntervalSec = 300;
                  StartLimitBurst = 5;
                };

                serviceConfig = {
                  User = cfg.user;
                  ExecStart = lib.getExe cfg.package;
                  # Drain-then-sweep; see execStopDrain above. Runs as cfg.user,
                  # which owns every process in the cgroup.
                  ExecStop = execStopDrain;
                  WorkingDirectory = cfg.workingDir;
                  EnvironmentFile = cfg.tokenFile;
                  Restart = "on-failure";
                  RestartSec = 5;
                  TimeoutStopSec = "1h";
                } // oomServiceConfig cfg.memory;
              };

              # Let the CI runner start only the release and force-restart
              # oneshots. `personal-assistant-release@<tag>` is templated, so the
              # boundary is a PATTERN rather than a name: only a
              # vMAJOR.MINOR.PATCH instance is reachable, and the host's
              # pa-release re-validates the tag rather than trusting this regex.
              # `personal-assistant-deploy` — which ships unreleased main — is
              # deliberately absent: that is a manual decision, not one a
              # workflow may take. PR preview permissions are added below when
              # previews are enabled.
              security.polkit.extraConfig = ''
                polkit.addRule(function(action, subject) {
                  if (action.id == "org.freedesktop.systemd1.manage-units" &&
                      subject.user == "${pr.deployUser}") {
                    var unit = action.lookup("unit");
                    if (unit == "personal-assistant-force-restart.service" ||
                        /^personal-assistant-release@v[0-9]+\.[0-9]+\.[0-9]+\.service$/.test(unit)) {
                      return polkit.Result.YES;
                    }
                  }
                });
              '';
            }

            (lib.mkIf pr.enable {
              assertions = [
                {
                  assertion = pr.credentialEnvironmentFile == null
                    || lib.hasInfix "%i" pr.credentialEnvironmentFile;
                  message = "services.personal-assistant.prDeployments.credentialEnvironmentFile must contain %i so preview credentials are per instance";
                }
                {
                  assertion = pr.credentialEnvironmentFile == null
                    || cfg.tokenFile == null
                    || pr.credentialEnvironmentFile != cfg.tokenFile;
                  message = "Preview credentialEnvironmentFile must not reuse the production tokenFile";
                }
              ];

              # Manual escape hatch: `sudo pa-pr {deploy,teardown} <n>`.
              environment.systemPackages = [ paPr ];

              # PR preview instance (one per PR number via the @<n> instance).
              # It shares the host tool PATH and Unix uid with production, but not
              # production's HOME, tokenFile, extraEnvironment, or data.
              # Started/stopped imperatively by pa-pr, never wanted-by a target.
              systemd.services."pa-pr@" = {
                description = "Pandeck PR %i preview";
                # Preview package selection comes from each instance's env file and
                # is changed only by `pa-pr deploy`. Do not restart previews during
                # an unrelated main activation: a broken/stale preview must not
                # block production deployment.
                restartIfChanged = false;
                after = [ "network-online.target" ];
                wants = [ "network-online.target" ];
                path = servicePath;
                environment = {
                  NODE_ENV = "production";
                  ASSISTANT_HOST = cfg.host;
                  HOME = "${pr.stateDir}/%i/home";
                  XDG_CONFIG_HOME = "${pr.stateDir}/%i/home/.config";
                  XDG_DATA_HOME = "${pr.stateDir}/%i/home/.local/share";
                  XDG_STATE_HOME = "${pr.stateDir}/%i/home/.local/state";
                  XDG_CACHE_HOME = "${pr.stateDir}/%i/home/.cache";
                  LOCALE_ARCHIVE = "/run/current-system/sw/lib/locale/locale-archive";
                  TZDIR = "/etc/zoneinfo";
                  # Dictation off, explicitly. Previews used to avoid the ~2 GB
                  # recognizer only because the module handed the recognizer path
                  # to prod alone — but the server also falls back to a PATH lookup
                  # for it, so now that the recognizer is a host tool every preview
                  # would otherwise find it and be able to warm its own copy.
                  ASSISTANT_STT_DISABLED = "1";
                  # Never invoke the one-time production legacy ~/.pi seed. HOME
                  # above also gives default Claude an empty preview-local profile
                  # instead of the service user's production ~/.claude login.
                  ASSISTANT_LEGACY_PI_AGENT_DIR = "${pr.stateDir}/%i/home/no-legacy-pi-agent";
                  # A preview must not act as production on Slack. This remains a
                  # second guard after removing production env files and settings:
                  # Socket Mode load-balances real events across open connections.
                  ASSISTANT_SLACK_APP_DISABLED = "1";
                } // settingsEnv;
                serviceConfig = {
                  User = cfg.user;
                  WorkingDirectory = cfg.workingDir;
                  EnvironmentFile = [ "${pr.stateDir}/%i/env" ]
                    ++ lib.optional (pr.credentialEnvironmentFile != null)
                      pr.credentialEnvironmentFile;
                  ExecStartPre = "${previewStateGuard} ${lib.escapeShellArg pr.stateDir} %i";
                  # The binary must be a literal path, so exec the per-instance
                  # ASSISTANT_PACKAGE (from the env file) through bash.
                  ExecStart = "${pkgs.bashInteractive}/bin/bash -c 'exec \"$ASSISTANT_PACKAGE\"'";
                  Restart = "on-failure";
                  RestartSec = 5;
                } // oomServiceConfig pr.memory;
              };

              # Fixed root oneshots the CI runner starts over D-Bus (authorized by
              # the polkit rule below). The command is fixed in the unit, so the
              # runner gets no other root. `%i` is the PR number.
              # An activation must never stop a RUNNING instance of these: they
              # drive the switch/preview themselves, so a changed unit file would
              # otherwise make an in-flight run SIGTERM itself mid-deploy. A
              # oneshot picks up its new definition on the next start anyway.
              systemd.services."pa-pr-deploy@" = {
                description = "Deploy personal-assistant PR %i preview";
                restartIfChanged = false;
                serviceConfig = {
                  Type = "oneshot";
                  ExecStart = "${paPr}/bin/pa-pr deploy %i";
                };
              };
              systemd.services."pa-pr-teardown@" = {
                description = "Tear down personal-assistant PR %i preview";
                restartIfChanged = false;
                serviceConfig = {
                  Type = "oneshot";
                  ExecStart = "${paPr}/bin/pa-pr teardown %i";
                };
              };

              # Let the CI runner start the PR deploy/teardown instances (any
              # PR number), in addition to the production oneshots above.
              security.polkit.extraConfig = ''
                polkit.addRule(function(action, subject) {
                  if (action.id == "org.freedesktop.systemd1.manage-units" &&
                      subject.user == "${pr.deployUser}") {
                    var unit = action.lookup("unit");
                    if (unit && (unit.indexOf("pa-pr-deploy@") == 0 ||
                                 unit.indexOf("pa-pr-teardown@") == 0)) {
                      return polkit.Result.YES;
                    }
                  }
                });
              '';
            })
          ]);
        };
      nixosModules.personal-assistant = self.nixosModules.default;
    };
}

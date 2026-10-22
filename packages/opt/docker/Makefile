# This Makefile is a thin wrapper around the upstream katzenpost docker
# Makefile: it adds a few local targets and passes everything else through
# with `$(MAKE) -e`. Because every variable here is exported (see `export`
# below) and `-e` lets the environment win, anything defined here overrides
# upstream's own definition -- so define as little as possible.
#
# Variables come in two flavors:
#   local policy  - deliberate differences from upstream defaults.
#   mirrored      - plumbing upstream also defines, duplicated only because
#                   this Makefile's own recipes need the value. Re-check these
#                   against $(katzenpost_dir)/docker/Makefile on every
#                   katzenpost upgrade. Currently mirrored from v0.0.107.
# Everything else (decoy toggles, epoch_duration, TRANSPORT, log_level,
# base_port, ...) is inherited from upstream.

katzenpost_dir?=/tmp/katzenpost.opt
katzenpost_version?=$(shell grep -E '^	github.com/katzenpost/katzenpost ' ../go.mod | awk '{print $$2}')

### local policy
# a small network; upstream defaults are 7 mixes, 6 auths, 5 gateways,
# 4 storage nodes. mixes must be at least layers.
compression?=true
layers=3
mixes=3
auths=3
gateways=1
storageNodes=5
# a single service node: custom-config injects the rpc_proxy plugin into
# servicenode1 only (upstream default is 4).
serviceNodes=1
# walletshield's RPC bodies need more room than upstream's 2000.
UserForwardPayloadLength=30000

### mirrored from upstream
distro=alpine
net_name=mixnet-$(distro)
docker_compose_yml=$(net_name)/docker-compose.yml
sh?=bash
cache_dir?=cache
go_mod_cache=$(cache_dir)/go
go_build_cache=$(cache_dir)/go-build-$(distro)
docker?=$(shell command -v podman >/dev/null 2>&1 && echo podman || echo docker)
uid?=$(shell [ "$$SUDO_UID" != "" ] && echo "$$SUDO_UID" || id -u)
gid?=$(shell [ "$$SUDO_GID" != "" ] && echo "$$SUDO_GID" || id -g)
docker_user?=$(shell if echo ${docker}|grep -q podman; then echo 0:0; else echo ${uid}:${gid}; fi)

# upstream's docker_args, rooted at $(katzenpost_dir) instead of the relative
# `..`/`.` that only resolve correctly from katzenpost/docker, plus:
#   git_safe_dir       - the repos are bind-mounted from the host, so the
#                        container user may not own them (e.g. a docker
#                        wrapper that drops --user). git then refuses with
#                        "detected dubious ownership" (exit 128) and `go build`
#                        fails VCS stamping. Relaxing the check for the
#                        ephemeral build container keeps version stamping.
#   extra_docker_args  - escape hatch for ad-hoc flags.
git_safe_dir=-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*'
extra_docker_args?=
docker_args=--user ${docker_user} --volume $(kp_dir):/go/katzenpost --workdir /go/katzenpost \
	-v $(kp_docker_dir)/$(go_mod_cache):/go/ \
	-v $(kp_docker_dir)/$(go_build_cache):/gocache/ \
	-e GOCACHE=/gocache -e GOPATH=/go --pids-limit 4096 \
	$(git_safe_dir) $(extra_docker_args)
mount_net_name=-v $(kp_docker_dir)/$(net_name):/$(net_name)

### network selection
# network=<file> reads a network profile, a Make file, after the defaults
# above: it overrides them (its own net_name included) and may add targets,
# so every target sees the same network without repeating knobs. Unset: the
# local network above. The command line still wins over both.
network?=
ifneq ($(network),)
include $(network)
endif

### local
# ldflags for our binaries: upstream's ldflags_body plus the compression flag
# and the version. Not named ldflags, which would override upstream's (and its
# BuildVersion stamp). The version is taken on the host: the build container
# mounts only this module, without the repository's .git, so Go has no VCS
# metadata to stamp.
opt_version:=$(shell git -C .. describe --tags --always --dirty 2>/dev/null)
opt_ldflags="-extldflags=-Wl,-z,stack-size=0x1F40000 -buildid= -X github.com/ZeroKnowledgeNetwork/opt/common.CompressionEnabled=${compression} -X main.version=${opt_version}"
kp_dir=$(shell readlink -f $(katzenpost_dir))
kp_docker_dir=$(kp_dir)/docker
# What our binaries build from: every Go source in this module plus go.mod and
# go.sum. A change to any of them rebuilds the binaries on the next `start`.
# Not exported: upstream has no use for it.
opt_go_sources:=$(shell find .. -name '*.go' -not -path '../docker/*') ../go.mod ../go.sum
unexport opt_go_sources
net_dir=$(kp_docker_dir)/$(net_name)
mount_opt=-v $(shell readlink -f ..):/go/opt
docker_run_sh=$(docker) run ${docker_args} $(mount_net_name) $(mount_opt) --rm katzenpost-$(distro)_base $(sh) -c
# The compose network of the current net_name, derived in the shell like
# upstream's compose_network_name (which must not be defined here: it would be
# exported and override upstream's own).
compose_network_sh=printf '%s_%s_katzenpost-net' '$(net_name)' "$$(cat $(kp_docker_dir)/.base_port_seed | sha1sum | head -c 5)" | tr -d .
unexport compose_network_sh

# rpc_proxy's log level, passed as its -log_level flag; empty keeps the
# plugin's default (DEBUG).
rpc_proxy_log_level?=
# true turns off the logging of every node and of kpclientd ([Logging] Disable).
log_disable?=false

# export variables to the environment for consumption by invoked Makefile(s)
export

# The rpc_proxy plugin for every service node; @node@ is the node's name.
define SERVICENODE_PLUGINS
  [[ServiceNode.CBORPluginKaetzchen]]
    Capability = "rpc_proxy"
    Endpoint = "rpc_proxy"
    Command = "/$(net_name)/rpc_proxy.$(distro)"
    MaxConcurrency = 1
    Disable = false
    [ServiceNode.CBORPluginKaetzchen.Config]
      config = "/$(net_name)/@node@/rpc_proxy_config.toml"
      log_dir = "/$(net_name)/@node@"$(if $(rpc_proxy_log_level),
      log_level = "$(rpc_proxy_log_level)")
endef

.PHONY: help
help:
	@echo
	@echo "These make targets allow you to control custom apps:"
	@echo " walletshield-start - start walletshield client"
	@echo " walletshield-logs  - show walletshield logs"
	@echo " walletshield-stop  - stop walletshield client"
	@echo " walletshield-probe - run walletshield test probe"
	@$(MAKE) -e -C $(katzenpost_dir)/docker $@

.PHONY: custom-binaries
custom-binaries: $(net_dir)/rpc_proxy.$(distro)

.PHONY: custom-config
custom-config:
	@for dir in $(net_dir)/servicenode*/; do \
		[ -d "$$dir" ] || continue; \
		node="$$(basename "$$dir")"; \
		file="$$dir/katzenpost.toml"; \
		tmp="$$(mktemp)"; \
		plugin="$$(mktemp)"; \
		sed '/^# BEGIN SERVICENODE_PLUGINS$$/,/^# END SERVICENODE_PLUGINS$$/d' "$$file" > "$$tmp"; \
		{ \
			echo '# BEGIN SERVICENODE_PLUGINS'; \
			printf '%s\n' "$$SERVICENODE_PLUGINS" | sed "s/@node@/$$node/g"; \
			echo '# END SERVICENODE_PLUGINS'; \
		} > "$$plugin"; \
		sed "/^\[ServiceNode\]$$/r $$plugin" "$$tmp" > "$$file"; \
		rm -f "$$tmp" "$$plugin"; \
		cp $(opt_config_sources) "$$dir"; \
	done
	@for file in $(net_dir)/*/katzenpost.toml $(net_dir)/*/authority.toml $(net_dir)/client/client.toml; do \
		if [ -f "$$file" ]; then \
			sed -i '/^\[Logging\]$$/,/^\[/s/^\( *Disable = \).*/\1$(log_disable)/' "$$file" || exit 1; \
		fi; \
	done

.PHONY: clone-katzenpost
clone-katzenpost:
	if [ ! -d "$(katzenpost_dir)" ]; then \
		git clone \
			--branch $(katzenpost_version) \
			--depth 1 \
			--single-branch \
			https://github.com/katzenpost/katzenpost.git \
			$(katzenpost_dir); \
	fi

# Sources are plain files: the empty rule keeps the pass-through `%` rule below
# from treating them as upstream targets.
opt_config_sources=../server_plugins/cbor_plugins/rpc_proxy/rpc_proxy_config.toml
unexport opt_config_sources
$(opt_go_sources) $(opt_config_sources): ;

$(net_dir)/rpc_proxy.$(distro): $(katzenpost_dir)/docker/$(distro)_base.stamp $(opt_go_sources) $(opt_config_sources) | $(net_name) $(cache_dir)
	$(docker_run_sh) 'cd /go/opt/server_plugins/cbor_plugins/rpc_proxy/cmd/rpc_proxy ; go build -trimpath -ldflags ${opt_ldflags} && mv rpc_proxy /$(net_name)/rpc_proxy.$(distro)'

# Holds the version the binaries were last built at, so a new commit rebuilds
# walletshield (whose /_/health reports it) even when no source changed.
$(net_dir)/opt_version.stamp: FORCE | $(net_name)
	@echo '$(opt_version)' | cmp -s - $@ || echo '$(opt_version)' > $@

.PHONY: FORCE
FORCE:

$(net_dir)/walletshield.$(distro): $(katzenpost_dir)/docker/$(distro)_base.stamp $(opt_go_sources) $(net_dir)/opt_version.stamp | $(net_name) $(cache_dir)
	$(docker_run_sh) 'cd /go/opt/apps/walletshield ; go build -trimpath -ldflags ${opt_ldflags} && mv walletshield /$(net_name)/walletshield.$(distro)'

.PHONY: walletshield-probe
walletshield-probe: $(net_dir)/walletshield.$(distro) $(net_dir)/running.stamp | $(cache_dir)
	$(docker) run --network=host $(docker_args) $(mount_net_name) --rm katzenpost-$(distro)_base \
		/$(net_name)/walletshield.$(distro) -config /$(net_name)/client/thinclient.toml -thin -log_level DEBUG -probe --probe_count 3

# client.toml dials container hostnames (gateway1, auth1, ...), so the full
# client must join the compose network, not the host's.
.PHONY: walletshield-probe-full
walletshield-probe-full: $(net_dir)/walletshield.$(distro) $(net_dir)/running.stamp | $(cache_dir)
	net="$$($(compose_network_sh))"; \
	$(docker) run --network=$$net $(docker_args) $(mount_net_name) --rm katzenpost-$(distro)_base \
		/$(net_name)/walletshield.$(distro) -config /$(net_name)/client/client.toml --listen_client :64333 -log_level DEBUG -probe --probe_count 3

# walletshield-start's log level: DEBUG or INFO (what the shipped clients run)
ws_log_level?=DEBUG

.PHONY: walletshield-start
walletshield-start: $(net_dir)/walletshield.$(distro) $(net_dir)/running.stamp | $(cache_dir)
	$(docker) run -d --network=host $(docker_args) $(mount_net_name) --name walletshield katzenpost-$(distro)_base \
		/$(net_name)/walletshield.$(distro) -config /$(net_name)/client/thinclient.toml -thin -listen :7070 -log_level $(ws_log_level)

.PHONY: walletshield-logs
walletshield-logs:
	$(docker) logs --tail=100 walletshield

.PHONY: walletshield-stop
walletshield-stop:
	-$(docker) stop walletshield && $(docker) rm walletshield

.PHONY: clean
clean: walletshield-stop
	$(MAKE) -e -C $(katzenpost_dir)/docker $@
	rm -rf $(katzenpost_dir)

# start the testnet in the background with the local customizations
start: clone-katzenpost $(docker_compose_yml) custom-config custom-binaries
	$(MAKE) -e -C $(katzenpost_dir)/docker $@

# A network without storage replicas: upstream's wait requires two (fetch -r 2),
# so this one runs the same readiness check with wait_min_replicas instead.
# Mirrored from upstream's wait (v0.0.107), with its own deadline: upstream's
# wait_seconds (5 epochs) is not visible here.
ifneq ($(wait_min_replicas),)
wait_min_replicas_seconds?=600
.PHONY: wait
wait: clone-katzenpost
	$(MAKE) -e -C $(katzenpost_dir)/docker check-net-transport $(net_name)/running.stamp $(net_name)/client/thinclient-bridge.toml
	@net="$$($(compose_network_sh))"; \
	deadline=$$(( $$(date +%s) + $(wait_min_replicas_seconds) )); \
	until left=$$(( deadline - $$(date +%s) )); [ $$left -gt 0 ] || exit 1; \
		$(docker) run --network=$$net $(docker_args) $(mount_net_name) --rm katzenpost-$(distro)_base \
		/$(net_name)/fetch.$(distro) -f /$(net_name)/client/thinclient-bridge.toml -r $(wait_min_replicas) --require-ready --ready-timeout $${left}s; do \
		echo "wait: the client daemon is not accepting connections yet; retrying"; sleep 5; done
endif

# Stops the network and deletes its directory. The containers run as root, so
# files they wrote (e.g. mixkeys/) are root's: a container deletes them.
.PHONY: clean-network
clean-network: stop
	$(if $(filter-out /%,$(net_name)),,$(error net_name must be a relative name))
	$(docker) run --rm -v $(kp_docker_dir):/w katzenpost-$(distro)_base rm -rf /w/$(net_name)

# Makefiles are sources: the empty rules keep the pass-through `%` rule below
# from trying to remake them through upstream.
Makefile: ;
$(network): ;

# pass through all other targets to katzenpost/docker/Makefile
%: clone-katzenpost
	@echo ">> Passing '$@' to $(katzenpost_dir)/docker/Makefile"
	$(MAKE) -e -C $(katzenpost_dir)/docker $@

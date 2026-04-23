.PHONY: build deploy

NETWORK ?= testnet
RPC_URL ?= https://soroban-testnet.stellar.org

build:
	soroban contract build

deploy:
	@echo "Deploying to $(NETWORK) via $(RPC_URL)"
	@echo "You must have a funded identity configured in soroban CLI."
	soroban contract deploy \
		--wasm target/wasm32-unknown-unknown/release/cert_registry.wasm \
		--network $(NETWORK) \
		--rpc-url $(RPC_URL)


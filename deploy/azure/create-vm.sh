#!/usr/bin/env bash
# Cheapest always-on pattern on Azure: one B-series VM + Docker.
# Container Apps is fine for the HTTPS portal, but inbound SMTP on port 25 is
# unreliable there. A small VM keeps mail flow simple and costs ~US$8–15/month.
set -euo pipefail
: "${RESOURCE_GROUP:?}"
: "${LOCATION:=eastus}"
: "${VM_NAME:=signer}"

az group create -n "$RESOURCE_GROUP" -l "$LOCATION"
az vm create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --image Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest \
  --size Standard_B2ats_v2 \
  --public-ip-sku Standard \
  --nsg-rule SSH \
  --admin-username azureuser \
  --generate-ssh-keys

az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 3000 --priority 1100
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 25 --priority 1101
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 587 --priority 1102
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 443 --priority 1103

echo "SSH in, install docker, copy this repo, copy .env, then: docker compose up -d"
echo "Point PUBLIC_URL at http(s)://<public-ip>:3000 (put Caddy/nginx in front for TLS)."
echo "If outbound TCP 25 is blocked (common on Azure), open a support request for an SMTP exemption, or set Exchange send connector to host:587 and UPSTREAM_PORT accordingly."

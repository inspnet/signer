#!/usr/bin/env bash
# Cheapest always-on pattern on Azure: one B-series VM + Docker.
# Container Apps is fine for the HTTPS portal, but inbound SMTP on port 25 is
# unreliable there. A small VM keeps mail flow simple and costs ~US$8–15/month.
#
# LOCATION must be a generally-available commercial region (see README
# "Compatible regions and zones"). Restricted DR regions and sovereign clouds
# will fail or cannot run this product's Entra / Let's Encrypt path.
# Outbound TCP 25 is a subscription policy (EA/MCA-E), not a region setting.
set -euo pipefail
: "${RESOURCE_GROUP:?}"
: "${LOCATION:=eastus}"
: "${VM_NAME:=signer}"
: "${VM_SIZE:=Standard_B2als_v2}"

az group create -n "$RESOURCE_GROUP" -l "$LOCATION"
az vm create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --image Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest \
  --size "$VM_SIZE" \
  --public-ip-sku Standard \
  --nsg-rule SSH \
  --admin-username azureuser \
  --generate-ssh-keys

az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 80 --priority 1100
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 443 --priority 1101
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 25 --priority 1102
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 587 --priority 1103
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 3000 --priority 1104

IP=$(az vm show -d -g "$RESOURCE_GROUP" -n "$VM_NAME" --query publicIps -o tsv)
echo "VM public IP: $IP"
echo "Create a DNS A record for signer.example.com → $IP, then follow README.md (Azure) for Docker, Caddy, .env, and mail connectors."
echo "If outbound TCP 25 is blocked (common on Azure), open a support request for an SMTP exemption so signed mail can return to mail.protection.outlook.com."

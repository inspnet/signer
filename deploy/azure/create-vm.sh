#!/usr/bin/env bash
# Cheapest always-on pattern on Azure: one B-series VM + Docker.
# Do not open SMTP to the internet. 587 is for Google (TLS). Exchange Online
# smart-hosts on TCP 25 with STARTTLS — add an NSG rule sourced from Office365
# only if you use Microsoft 365 (see README).
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

az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 80 --priority 1100
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 443 --priority 1101
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 587 --priority 1102

NSG=$(az network nsg list -g "$RESOURCE_GROUP" --query "[?contains(name, '$VM_NAME')].name | [0]" -o tsv)
if [[ -n "$NSG" ]]; then
  az network nsg rule create \
    --resource-group "$RESOURCE_GROUP" \
    --nsg-name "$NSG" \
    --name allow-exchange-online-smtp \
    --priority 1103 \
    --direction Inbound \
    --access Allow \
    --protocol Tcp \
    --source-address-prefixes Office365 \
    --destination-port-ranges 25 587 \
    --description "Exchange Online STARTTLS to Signer (not the open internet)" \
    >/dev/null || true
fi

IP=$(az vm show -d -g "$RESOURCE_GROUP" -n "$VM_NAME" --query publicIps -o tsv)
echo "VM public IP: $IP"
echo "Create a DNS A record for signer.example.com → $IP, then follow README.md (Azure)."
echo "SMTP 587 is open; TCP 25 is allowed only from the Office365 service tag (Microsoft STARTTLS)."
echo "If outbound TCP 25 to mail.protection.outlook.com is blocked, request an SMTP exemption."

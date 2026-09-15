#!/usr/bin/env bash
# GCP: e2-small (or e2-micro for labs) Compute Engine VM + Docker.
# Cloud Run cannot accept inbound SMTP, so a tiny VM is the low-cost path.
set -euo pipefail
: "${PROJECT:?}"
: "${ZONE:=us-central1-a}"
: "${NAME:=signer}"

gcloud config set project "$PROJECT"
gcloud compute firewall-rules create signer-mail --allow tcp:25,tcp:587,tcp:2525,tcp:3000,tcp:443 --target-tags=signer || true
gcloud compute instances create "$NAME" \
  --zone "$ZONE" \
  --machine-type e2-small \
  --tags signer \
  --image-family ubuntu-2204-lts \
  --image-project ubuntu-os-cloud \
  --boot-disk-size 20GB \
  --metadata=startup-script='#!/bin/bash
apt-get update
apt-get install -y docker.io docker-compose-v2
systemctl enable --now docker
'

echo "SSH: gcloud compute ssh $NAME --zone $ZONE"
echo "Then clone the repo, create .env, docker compose up -d"
echo "GCP also blocks outbound port 25 by default. Use 587 to Google smtp-relay.gmail.com, and request SMTP if you must hit Microsoft MX on 25."

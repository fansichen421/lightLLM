# Docker / Container usage for lightLLM

This document explains how to build and run a container image for the lightLLM project.

Important notes before running
- GPU drivers (NVIDIA/AMD) must be installed on the host. A container cannot install kernel drivers.
- For AMD ROCm, host ROCm drivers matching the desired ROCm version (>=7.1) must be present.
- Ollama and large models may need significant disk space. It's recommended to mount a persistent volume (example uses `~/LightLLM`).

Build the image

```bash
cd /path/to/lightLLM
# build
docker build -t fansichen421/lightllm:latest .
```

Run container (interactive)

```bash
# Example run (no GPU):
docker run --rm -it \
  -v "$(pwd)":/opt/lightLLM \
  -v "$HOME/LightLLM":/root/LightLLM \
  -p 7860:7860 \
  fansichen421/lightllm:latest /bin/bash

# Inside container, you can run setup non-interactively:
./setup.sh -y
```

Run with docker-compose

```bash
docker compose up --build -d
# to run setup inside the running container:
docker exec -it lightllm /usr/local/bin/docker-entrypoint.sh setup
```

GPU notes

- AMD (ROCm): Host must have ROCm installed. Start the container with device access to `/dev/kfd` and `/dev/dri` and sometimes `--privileged`:

```bash
docker run --device /dev/kfd --device /dev/dri --group-add video --privileged -v "$(pwd)":/opt/lightLLM -v "$HOME/LightLLM":/root/LightLLM -it fansichen421/lightllm:latest /usr/local/bin/docker-entrypoint.sh setup
```

- NVIDIA: Use `--gpus all` and NVIDIA container toolkit configured on the host.

Model storage and size

- Pulling `gpt-oss:latest` or `qwen3:4b` will download large model files. Keep them on a mounted persistent volume like `~/LightLLM` to avoid re-downloading on container recreation.

Security and best practices

- The image contains the `setup.sh` installer. The `setup.sh` script is not run automatically during `docker build` to avoid embedding large models in the image.
- Avoid putting sensitive credentials into the image. Use environment variables and Docker secrets for tokens.

Publishing the image

- Tag and push to a registry (Docker Hub, GitHub Container Registry, etc.):

```bash
# example for Docker Hub
docker tag fansichen421/lightllm:latest fansichen421/lightllm:0.1.0
docker push fansichen421/lightllm:0.1.0
```

Troubleshooting

- If ROCm tools like `rocminfo` cannot see devices inside container, check host drivers and device mapping.
- If `ollama` requires systemd or other host-level services, prefer running `ollama` on host and mount model directory into container.


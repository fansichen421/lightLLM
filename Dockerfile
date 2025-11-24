# Dockerfile for lightLLM one-click container
# Base on Ubuntu 24.04 as required
FROM ubuntu:24.04

LABEL maintainer="fansichen421"
ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/opt/conda/bin:$PATH

# Install essential packages
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates curl wget gnupg lsb-release git sudo build-essential procps lshw \
     python3 python3-pip python3-venv unzip locales \
  && rm -rf /var/lib/apt/lists/*

# Set locale
RUN locale-gen en_US.UTF-8 || true
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Install Miniconda (silent)
ARG CONDA_DIR=/opt/conda
RUN wget -qO /tmp/miniconda.sh https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh \
  && bash /tmp/miniconda.sh -b -p ${CONDA_DIR} \
  && rm -f /tmp/miniconda.sh \
  && ${CONDA_DIR}/bin/conda init bash || true

# Ensure conda is on PATH
ENV PATH=${CONDA_DIR}/bin:${PATH}

# Copy repository and setup script
WORKDIR /opt/lightLLM
COPY . /opt/lightLLM
RUN chmod +x /opt/lightLLM/setup.sh || true

# Add an entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Default working dir
WORKDIR /opt/lightLLM

# Recommended volumes: /root/LightLLM for persisted data
VOLUME ["/root/LightLLM"]

# Expose common ports (user can override)
EXPOSE 7860 8000 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/bin/bash"]

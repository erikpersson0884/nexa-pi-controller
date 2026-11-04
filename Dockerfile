FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-flask python3-lgpio python3-dotenv \
 && rm -rf /var/lib/apt/lists/*

COPY webui.py /app/webui.py

# lgpio writes small temporary files to the working directory, so it must be writable
WORKDIR /data
CMD ["python3", "/app/webui.py"]
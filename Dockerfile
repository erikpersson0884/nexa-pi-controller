FROM python:3.12-slim-bookworm

# lgpio is built from source by pip, so it needs a compiler and swig
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential swig \
 && pip install --no-cache-dir flask python-dotenv lgpio \
 && rm -rf /var/lib/apt/lists/*

COPY webui.py /app/webui.py

# lgpio writes small temporary files to the working directory, so it must be writable
WORKDIR /data
CMD ["python3", "/app/webui.py"]
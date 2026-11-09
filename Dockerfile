FROM python:3.12-slim-bookworm

# lgpio is built from source by pip, so it needs a compiler and swig
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential swig \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY nexa-pi-controller /app/nexa-pi-controller
COPY gunicorn.conf.py /app/

# lgpio writes small temporary files to the working directory, so it must be writable
WORKDIR /app
ENV PYTHONPATH=/app/nexa-pi-controller
CMD ["gunicorn", "-c", "/app/gunicorn.conf.py", "webui:app"]

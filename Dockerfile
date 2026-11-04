FROM python:3.12-slim-bookworm

# lgpio is built from source by pip, so it needs a compiler and swig
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential swig \
 && pip install --no-cache-dir flask flask-wtf python-dotenv lgpio gunicorn \
 && rm -rf /var/lib/apt/lists/*

COPY webui.py /app/webui.py
COPY config.py radio.py scheduler.py storage.py /app/
COPY gunicorn.conf.py /app/
COPY templates /app/templates
COPY static /app/static

# lgpio writes small temporary files to the working directory, so it must be writable
WORKDIR /app
CMD ["gunicorn", "-c", "/app/gunicorn.conf.py", "webui:app"]
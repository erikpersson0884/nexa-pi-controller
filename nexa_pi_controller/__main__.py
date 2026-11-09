from .webui import HOST, PORT, app, start_background_services

if __name__ == "__main__":
    start_background_services()
    app.run(host=HOST, port=PORT)
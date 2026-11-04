bind = "0.0.0.0:8080"
workers = 1
threads = 4
accesslog = "-"
errorlog = "-"


def post_worker_init(worker):
    import threading

    import webui

    threading.Thread(target=webui.scheduler, daemon=True).start()

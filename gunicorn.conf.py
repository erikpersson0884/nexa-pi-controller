bind = "0.0.0.0:8080"
workers = 1
threads = 4
accesslog = "-"
errorlog = "-"


def post_worker_init(worker):
    from nexa_pi_controller import webui

    webui.start_background_services()

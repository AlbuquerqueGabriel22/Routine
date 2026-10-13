import argparse

import uvicorn

from main import app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    arguments = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=arguments.port, log_level="error")


if __name__ == "__main__":
    main()

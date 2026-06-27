"""PyInstaller 用エントリポイント。FastAPI サーバを起動する。"""
import multiprocessing

from backend.server import main

if __name__ == "__main__":
    multiprocessing.freeze_support()  # 凍結環境での子プロセス対策
    main()

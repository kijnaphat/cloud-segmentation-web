FROM python:3.10-slim

WORKDIR /app

# ติดตั้ง Library ของระบบที่จำเป็นสำหรับ OpenCV และ Rasterio
RUN apt-get update && apt-get install -y libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# สร้างโฟลเดอร์สำหรับเก็บไฟล์รันและโมเดล
RUN mkdir -p runs models

# Hugging Face Spaces บังคับใช้ Port 7860
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
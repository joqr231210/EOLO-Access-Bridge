FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    EASYOCR_HOME=/root/.EasyOCR

WORKDIR /app
RUN mkdir -p /app/data /app/static/captures

# Instala dependencias del sistema
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copia e instala dependencias
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copia el resto del código
COPY . .

# Dar permisos de ejecución al binario
RUN chmod +x ./stream/rtsptomse

# Exponer API interna ANPR y preview RTSP
EXPOSE 8090 8083

COPY gunicorn_config.py .

# Comando por defecto — servidor WSGI de producción
CMD ["gunicorn", "--config", "gunicorn_config.py", "web_config:app"]

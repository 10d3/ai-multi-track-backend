# Utiliser l'image de base oven/bun:latest
FROM oven/bun:latest

# Définir le répertoire de travail
WORKDIR /app

# Copier les fichiers du projet
COPY . /app/

# Installer Python et pip
RUN apt-get update && apt-get install -y python3 python3-pip

# Installer les dépendances Node.js avec bun
RUN bun add @prisma/client prisma
RUN bun install
RUN bun --bunx prisma generate

# Copier le fichier requirements.txt
COPY requirements.txt .

# Installer les dépendances Python
RUN pip install ffmpeg-python
RUN pip3 install spleeter

# Exposer le port pour l'application
EXPOSE 8080

# Définir la commande pour démarrer l'application
# CMD ["bun", "dev", "worker"]
CMD ["sh", "-c", "bun dev & bun worker"]
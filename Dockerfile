FROM node:22-bookworm

# Install Go for gherkio
RUN apt-get update && apt-get install -y wget && \
    wget -q https://go.dev/dl/go1.22.4.linux-amd64.tar.gz && \
    tar -C /usr/local -xzf go1.22.4.linux-amd64.tar.gz && \
    rm go1.22.4.linux-amd64.tar.gz && \
    rm -rf /var/lib/apt/lists/*

ENV PATH=$PATH:/usr/local/go/bin:/root/go/bin

# Install gherkio
RUN go install github.com/muhfaris/gherkio@latest

WORKDIR /app

# Copy backend files
COPY package.json package-lock.json ./
RUN npm install

COPY . .

EXPOSE 8788

CMD ["npx", "wrangler", "pages", "dev", "public", "--compatibility-date=2026-06-25", "--port", "8788"]

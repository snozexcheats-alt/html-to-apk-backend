FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk curl unzip zip git nodejs npm ca-certificates && rm -rf /var/lib/apt/lists/*
# Install Gradle 8.7
RUN curl -fsSL https://services.gradle.org/distributions/gradle-8.7-bin.zip -o /tmp/gradle.zip && unzip -q /tmp/gradle.zip -d /opt && rm /tmp/gradle.zip
ENV PATH="/opt/gradle-8.7/bin:${PATH}"
# Android command line tools + SDK packages
ENV ANDROID_HOME=/opt/android-sdk
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools && curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/tools.zip && unzip -q /tmp/tools.zip -d /tmp/tools && mkdir -p ${ANDROID_HOME}/cmdline-tools/latest && cp -a /tmp/tools/cmdline-tools/. ${ANDROID_HOME}/cmdline-tools/latest/ && rm -rf /tmp/tools /tmp/tools.zip
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"
RUN yes | sdkmanager --licenses >/dev/null 2>&1 || true && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8080
CMD ["npm","start"]

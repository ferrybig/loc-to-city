#!/bin/sh
docker build -t cgeodata-demo .
docker save cgeodata-demo | gzip > cgeodata-demo.tar.gz
rsync --progress cgeodata-demo.tar.gz fernando@geodata.ferrybig.nl:docker/geocode/
ssh fernando@geodata.ferrybig.nl "docker load < docker/geocode/cgeodata-demo.tar.gz && cd docker/geocode && docker compose up -d"

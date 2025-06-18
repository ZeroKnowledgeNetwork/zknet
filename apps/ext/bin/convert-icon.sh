#!/bin/bash

s=${1:-./assets/zkn.svg}

convert ${s} -resize 16x16   ./public/icon/16.png
convert ${s} -resize 32x32   ./public/icon/32.png
convert ${s} -resize 48x48   ./public/icon/48.png
convert ${s} -resize 96x96   ./public/icon/96.png
convert ${s} -resize 128x128 ./public/icon/128.png

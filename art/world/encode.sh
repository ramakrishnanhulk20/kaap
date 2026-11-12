#!/usr/bin/env bash
# Turns the rendered frames into the files the site plays: the story, the loop that follows it,
# a narrower cut of each for phones, and the first and last pictures as stills.
#
#   bash encode.sh [frames folder] [destination folder]
#
# Needs ffmpeg. The frame numbers and the frame rate come from timeline.py.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
frames="${1:-$here/out/film}"
dest="${2:-$here/../../packages/web/public/world/film}"
mkdir -p "$dest"

fps=24
story_frames=216
loop_start=217
loop_frames=96

# A phone shows the right-hand 61 percent of the picture: the letter, the watchman and the
# treasury. The page's stylesheet expects exactly this cut.
phone_cut="crop=iw*0.61:ih:iw*0.277:0,scale=1098:900:flags=lanczos"

# The colour tags say what the numbers mean, so every browser shows the paper the same shade.
video=(-c:v libx264 -preset slow -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709
       -color_trc bt709 -color_range tv -movflags +faststart -an)
to_video="scale=in_range=pc:out_range=tv:out_color_matrix=bt709"

film() {
  local start="$1" count="$2" filter="$3" quality="$4" out="$5"
  ffmpeg -y -loglevel error -framerate "$fps" -start_number "$start" -i "$frames/frame_%04d.png" \
    -frames:v "$count" -vf "$filter" -crf "$quality" "${video[@]}" "$dest/$out"
}

still() {
  local frame="$1" filter="$2" out="$3"
  ffmpeg -y -loglevel error -i "$frames/frame_$(printf '%04d' "$frame").png" -vf "$filter" \
    -q:v 3 -pix_fmt yuvj444p "$dest/$out"
}

film 1 "$story_frames" "$to_video" 20 story.mp4
film "$loop_start" "$loop_frames" "$to_video" 20 loop.mp4
film 1 "$story_frames" "$phone_cut,$to_video" 22 story-phone.mp4
film "$loop_start" "$loop_frames" "$phone_cut,$to_video" 22 loop-phone.mp4

still 1 "null" first.jpg
still "$story_frames" "null" end.jpg
still 1 "$phone_cut" first-phone.jpg
still "$story_frames" "$phone_cut" end-phone.jpg

ls -l "$dest"

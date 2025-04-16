import sys
from pytubefix import YouTube
from pytubefix.cli import on_progress

url = sys.argv[1]
output_filename = sys.argv[2]

yt = YouTube(url, use_po_token = true)

# Get audio stream
audio_stream = yt.streams.filter(only_audio=True).first()

# Download as MP3
audio_stream.download(filename=output_filename)

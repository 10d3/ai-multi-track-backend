import sys
from spleeter.separator import Separator

def separate_audio(input_audio_path, output_directory):
    # Initialize Spleeter for 2 stems (vocals and accompaniment)
    separator = Separator('spleeter:2stems')
    separator.separate_to_file(input_audio_path, output_directory)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python separate_audio.py <input_audio_path> <output_directory>")
        sys.exit(1)

    input_audio_path = sys.argv[1]
    output_directory = sys.argv[2]

    separate_audio(input_audio_path, output_directory)

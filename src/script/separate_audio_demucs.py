import sys
import os
import subprocess
import psutil
import shutil
from pathlib import Path

MAX_HTDEMUCS_SEGMENT = 7.8
DEFAULT_MODEL = "htdemucs"  # You can change this to "mdx_extra_q" if needed

def check_memory_usage():
    """Check current memory usage"""
    memory = psutil.virtual_memory()
    return memory.percent, memory.available / (1024**3)  # Available GB

def get_optimal_segment_size(available_memory_gb, model_name):
    """Determine optimal segment size based on available memory and model"""
    if available_memory_gb >= 6:
        size = 10
    elif available_memory_gb >= 4:
        size = 8
    elif available_memory_gb >= 2:
        size = 4
    else:
        size = 2

    # If model is htdemucs, limit to 7.8
    if model_name == "htdemucs" and size > MAX_HTDEMUCS_SEGMENT:
        size = MAX_HTDEMUCS_SEGMENT

    return size

def separate_audio_demucs(input_audio_path, output_directory, model=DEFAULT_MODEL):
    """Separate audio using Demucs with memory optimization"""

    # Check memory availability
    mem_percent, mem_available = check_memory_usage()
    print(f"Available memory: {mem_available:.1f}GB ({100 - mem_percent:.1f}% free)")

    # Determine optimal segment
    segment_size = get_optimal_segment_size(mem_available, model)

    os.makedirs(output_directory, exist_ok=True)

    cmd = [
        'python', '-m', 'demucs.separate',
        '--device', 'cpu',
        '--segment', str(segment_size),
        '--two-stems', 'vocals',
        '--mp3',
        '--mp3-bitrate', '320',
        '-n', model,
        '--out', output_directory,
        input_audio_path
    ]

    print(f"Running Demucs with segment size: {segment_size}")
    print(f"Command: {' '.join(cmd)}")

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        print("Demucs processing completed successfully")
        print("STDOUT:", result.stdout)
        reorganize_output(input_audio_path, output_directory, model)
        return True
    except subprocess.CalledProcessError as e:
        print(f"Demucs processing failed: {e}")
        print("STDERR:", e.stderr)
        print("STDOUT:", e.stdout)
        return False

def reorganize_output(input_audio_path, output_directory, model_name):
    """Reorganize Demucs output to match Spleeter structure"""
    input_filename = Path(input_audio_path).stem
    demucs_output_dir = os.path.join(output_directory, model_name, input_filename)

    if os.path.exists(demucs_output_dir):
        target_dir = os.path.join(output_directory, input_filename)
        os.makedirs(target_dir, exist_ok=True)

        vocals_src = os.path.join(demucs_output_dir, 'vocals.mp3')
        accompaniment_src = os.path.join(demucs_output_dir, 'no_vocals.mp3')

        vocals_dst = os.path.join(target_dir, 'vocals.mp3')
        accompaniment_dst = os.path.join(target_dir, 'accompaniment.mp3')

        if os.path.exists(vocals_src):
            shutil.move(vocals_src, vocals_dst)
            print(f"Vocals saved to: {vocals_dst}")

        if os.path.exists(accompaniment_src):
            shutil.move(accompaniment_src, accompaniment_dst)
            print(f"Accompaniment saved to: {accompaniment_dst}")

        try:
            shutil.rmtree(os.path.join(output_directory, model_name))
        except:
            pass

def main():
    if len(sys.argv) != 3:
        print("Usage: python separate_audio_demucs.py <input_audio_path> <output_directory>")
        sys.exit(1)

    input_audio_path = sys.argv[1]
    output_directory = sys.argv[2]

    if not os.path.exists(input_audio_path):
        print(f"Error: Input file not found: {input_audio_path}")
        sys.exit(1)

    print(f"Processing: {input_audio_path}")
    print(f"Output directory: {output_directory}")

    success = separate_audio_demucs(input_audio_path, output_directory)

    if success:
        print("Audio separation completed successfully!")
        sys.exit(0)
    else:
        print("Audio separation failed!")
        sys.exit(1)

if __name__ == "__main__":
    main()

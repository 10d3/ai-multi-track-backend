import sys
import os
import subprocess
import psutil
import shutil
from pathlib import Path

def check_memory_usage():
    """Check current memory usage"""
    memory = psutil.virtual_memory()
    return memory.percent, memory.available / (1024**3)  # Available GB

def get_optimal_segment_size(available_memory_gb):
    """Determine optimal segment size based on available memory"""
    if available_memory_gb >= 6:
        return 10  # Default for good quality
    elif available_memory_gb >= 4:
        return 8   # Balanced
    elif available_memory_gb >= 2:
        return 4   # Conservative
    else:
        return 2   # Very conservative

def separate_audio_demucs(input_audio_path, output_directory):
    """Separate audio using Demucs with memory optimization"""
    
    # Check memory availability
    mem_percent, mem_available = check_memory_usage()
    print(f"Available memory: {mem_available:.1f}GB ({100-mem_percent:.1f}% free)")
    
    # Determine optimal settings
    segment_size = get_optimal_segment_size(mem_available)
    
    # Create output directory if it doesn't exist
    os.makedirs(output_directory, exist_ok=True)
    
    # Build Demucs command with memory optimizations
    cmd = [
        'python', '-m', 'demucs.separate',
        '--device', 'cpu',  # Force CPU usage (no GPU on VPS)
        '--segment', str(segment_size),  # Control memory usage
        '--two-stems', 'vocals',  # Only separate vocals/accompaniment like Spleeter
        '--mp3',  # Output as MP3 to save space
        '--mp3-bitrate', '320',  # High quality MP3
        '--out', output_directory,
        input_audio_path
    ]
    
    print(f"Running Demucs with segment size: {segment_size}")
    print(f"Command: {' '.join(cmd)}")
    
    try:
        # Run Demucs
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        print("Demucs processing completed successfully")
        print("STDOUT:", result.stdout)
        
        # Demucs creates a folder structure, let's reorganize to match Spleeter output
        reorganize_output(input_audio_path, output_directory)
        
        return True
        
    except subprocess.CalledProcessError as e:
        print(f"Demucs processing failed: {e}")
        print("STDERR:", e.stderr)
        print("STDOUT:", e.stdout)
        return False

def reorganize_output(input_audio_path, output_directory):
    """Reorganize Demucs output to match Spleeter structure"""
    
    # Get input filename without extension
    input_filename = Path(input_audio_path).stem
    
    # Demucs creates: output_dir/htdemucs/filename/vocals.mp3 and no_vocals.mp3
    demucs_output_dir = os.path.join(output_directory, 'htdemucs', input_filename)
    
    if os.path.exists(demucs_output_dir):
        # Create target directory structure (like Spleeter)
        target_dir = os.path.join(output_directory, input_filename)
        os.makedirs(target_dir, exist_ok=True)
        
        # Move files and rename to match Spleeter convention
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
        
        # Clean up original Demucs directory structure
        try:
            shutil.rmtree(os.path.join(output_directory, 'htdemucs'))
        except:
            pass

def main():
    if len(sys.argv) != 3:
        print("Usage: python separate_audio_demucs.py <input_audio_path> <output_directory>")
        sys.exit(1)

    input_audio_path = sys.argv[1]
    output_directory = sys.argv[2]
    
    # Validate input file exists
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
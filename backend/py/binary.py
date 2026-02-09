import struct
import json
import zlib
from typing import Dict, Any, Tuple, List

from projects import (
    get_project_data_for_download,
    create_project,
    update_project_metadata,
    update_project_stats,
    save_alignments,
)
from fixes import save_fixes
from phrases import save_phrases

# Binary format constants
MAGIC_HEADER = b'ALGF'  # AlignFix magic header
FORMAT_VERSION = 1
COMPRESSION_ENABLED = True

def get_project_data_for_binary_download(project_id):
    
    data = get_project_data_for_download(project_id, export_phrases=True)
    
    # Create improved binary format
    binary_content = b""
    
    # 1. Magic header and version
    binary_content += MAGIC_HEADER
    binary_content += struct.pack('>H', FORMAT_VERSION)  # 2 bytes for version
    
    # 2. Flags (compression, etc.)
    flags = 0x01 if COMPRESSION_ENABLED else 0x00
    binary_content += struct.pack('>B', flags)  # 1 byte for flags
    
    # 3. Create the main data payload
    payload = _create_payload(data)
    
    # 4. Compress if enabled
    if COMPRESSION_ENABLED:
        payload = zlib.compress(payload, level=6)
    
    # 5. Add payload size and payload
    binary_content += struct.pack('>I', len(payload))  # 4 bytes for payload size
    binary_content += payload
    
    # 6. Add checksum for data integrity
    checksum = zlib.crc32(binary_content) & 0xffffffff
    binary_content += struct.pack('>I', checksum)
    
    return binary_content

def _create_payload(data: Dict[str, Any]) -> bytes:
    """Create the main data payload with improved structure."""
    payload = b""
    
    # 1. Project metadata (JSON format for flexibility)
    project_json = json.dumps(data["project"], ensure_ascii=False).encode("utf-8")
    payload += struct.pack('>I', len(project_json))
    payload += project_json

    # 2. Alignments data
    payload += _pack_alignments(
        data["lines1"], 
        data["lines2"], 
        data["alignments"], 
        data["scores"]
    )
    
    # 3. Fixes data
    payload += _pack_fixes(data["fixes"])

    # 4. Phrases
    payload += _pack_phrases(data["phrases"])
    
    return payload

def _pack_alignments(lines1: List[str], lines2: List[str], 
                    alignments: List[str], scores: List[float]) -> bytes:
    """Pack alignment data efficiently."""
    data = b""

    print("Packing alignments:", len(lines1))
    
    # Number of alignments
    num_alignments = len(lines1)
    data += struct.pack('>I', num_alignments)
    
    for line1, line2, alignment, score in zip(lines1, lines2, alignments, scores):
        # Use length-prefixed strings for variable data
        line1_bytes = line1.encode("utf-8")
        line2_bytes = line2.encode("utf-8")
        alignment_bytes = alignment.encode("utf-8")
        
        # Pack with length prefixes
        data += struct.pack('>I', len(line1_bytes)) + line1_bytes
        data += struct.pack('>I', len(line2_bytes)) + line2_bytes
        data += struct.pack('>I', len(alignment_bytes)) + alignment_bytes
        data += struct.pack('>f', float(score))  # 4-byte float instead of string
    
    return data

def _pack_fixes(fixes: List[Dict[str, Any]]) -> bytes:
    """Pack fixes data efficiently."""
    data = b""
  
    print("Packing fixes:", len(fixes))
    # Number of fixes
    data += struct.pack('>I', len(fixes))
    
    for fix in fixes:
        # Pack strings with length prefixes
        for key in ["src_phrase", "src_fix", "tgt_phrase", "tgt_fix"]:
            value_bytes = str(fix[key]).encode("utf-8")
            data += struct.pack('>I', len(value_bytes)) + value_bytes
        
        # Pack numeric data efficiently
        data += struct.pack('>i', int(fix["direction"]))  # 4-byte signed int
        data += struct.pack('>I', int(fix["num_occurrences"]))  # 4-byte unsigned int
        data += struct.pack('>f', float(fix["percentage"]))  # 4-byte float
        
        # Pack optional metadata
        if "id" in fix:
            data += struct.pack('>I', int(fix["id"]))
        else:
            data += struct.pack('>I', 0)  # Default ID
        
        # Pack timestamp if available
        created_at_bytes = str(fix.get("created_at", "")).encode("utf-8")
        data += struct.pack('>I', len(created_at_bytes)) + created_at_bytes
    
    return data

def _pack_phrases(phrases: List[Dict[str, Any]]) -> bytes:
    """Pack phrases data efficiently."""
    data = b""
    print("Packing phrases:", len(phrases))
    # Number of phrases
    data += struct.pack('>I', len(phrases))
    for phrase in phrases:
        # Pack phrase string
        phrase_bytes = phrase["src_phrase"].encode("utf-8")
        data += struct.pack('>I', len(phrase_bytes)) + phrase_bytes
        # Pack target phrase string
        tgt_phrase_bytes = phrase["tgt_phrase"].encode("utf-8")
        data += struct.pack('>I', len(tgt_phrase_bytes)) + tgt_phrase_bytes
        # Pack direction
        data += struct.pack('>i', int(phrase["direction"]))
        # Pack number of occurrences
        data += struct.pack('>I', int(phrase["num_occurrences"]))
        # Pack occurrences
        data += struct.pack('>I', len(phrase.get("occurrences", [])))
        for occ in phrase.get("occurrences", []):
            data += struct.pack('>I', int(occ))
        # Pack timestamp if available
        created_at_bytes = str(phrase.get("created_at", "")).encode("utf-8")
        data += struct.pack('>I', len(created_at_bytes)) + created_at_bytes                          

    return data

def _ensure_bytes(data) -> bytes:
    """Convert various input types to bytes for Pyodide compatibility."""
    if isinstance(data, bytes):
        return data
    elif hasattr(data, 'tobytes'):
        return data.tobytes()
    elif hasattr(data, 'to_py'):
        return bytes(data.to_py())
    elif hasattr(data, '__iter__'):
        try:
            return bytes(data)
        except (TypeError, ValueError):
            pass
    
    # Last resort: try converting to list first
    try:
        return bytes(list(data))
    except Exception as e:
        raise TypeError(f"Cannot convert {type(data)} to bytes: {e}")

def import_project_data_from_binary(binary_content) -> int:
    """Import project data from improved binary format."""
    # Convert to bytes if it's a typed array from JavaScript
    binary_content = _ensure_bytes(binary_content)
    
    offset = 0
    
    # 1. Validate magic header
    magic = binary_content[offset:offset+4]
    if magic != MAGIC_HEADER:
        raise ValueError(f"Invalid file format. Expected {MAGIC_HEADER}, got {magic}")
    offset += 4
    
    # 2. Check version
    version = struct.unpack('>H', binary_content[offset:offset+2])[0]
    if version > FORMAT_VERSION:
        raise ValueError(f"Unsupported version {version}. Max supported: {FORMAT_VERSION}")
    offset += 2
    
    # 3. Read flags
    flags = struct.unpack('>B', binary_content[offset:offset+1])[0]
    is_compressed = bool(flags & 0x01)
    offset += 1
    
    # 4. Read payload size
    payload_size = struct.unpack('>I', binary_content[offset:offset+4])[0]
    offset += 4
    
    # 5. Extract and decompress payload
    payload = binary_content[offset:offset+payload_size]
    offset += payload_size
    
    if is_compressed:
        try:
            payload = zlib.decompress(payload)
        except zlib.error as e:
            raise ValueError(f"Failed to decompress data: {e}")
    
    # 6. Verify checksum
    expected_checksum = struct.unpack('>I', binary_content[offset:offset+4])[0]
    actual_checksum = zlib.crc32(binary_content[:-4]) & 0xffffffff
    if expected_checksum != actual_checksum:
        raise ValueError(f"Checksum mismatch. File may be corrupted.")
    
    # 7. Parse payload
    return _parse_payload(payload)

def _parse_payload(payload: bytes) -> int:
    """Parse the main data payload."""
    offset = 0
    
    # 1. Parse project metadata
    project_json_len = struct.unpack('>I', payload[offset:offset+4])[0]
    offset += 4
    project_meta = json.loads(payload[offset:offset+project_json_len].decode("utf-8"))
    offset += project_json_len
    
    print(f"Parsed project metadata, offset now: {offset}")
    
    # Create project
    project_id = create_project(project_meta["name"])
    update_project_metadata(
        project_id,
        project_meta["threshold"],
        project_meta["min_phrase_len"],
        project_meta["max_phrase_len"],
        project_meta["min_count"],
        project_meta["max_count"]
    )

    update_project_stats(
        project_id, stats=project_meta.get("stats", {})
    )
    
    # 2. Parse alignments
    offset = _parse_alignments(payload, offset, project_id)
    print(f"Parsed alignments, offset now: {offset}")
    
    # 3. Parse fixes
    if offset < len(payload):
        offset = _parse_fixes(payload, offset, project_id)
        print(f"Parsed fixes, offset now: {offset}")

    # 4. Parse phrases
    if offset < len(payload):
        offset = _parse_phrases(payload, offset, project_id)
        print(f"Parsed phrases, offset now: {offset}")
    
    return project_id

def _parse_alignments(payload: bytes, offset: int, project_id: int) -> int:
    """Parse alignments data from payload."""
    # Read number of alignments
    num_alignments = struct.unpack('>I', payload[offset:offset+4])[0]
    offset += 4
    
    src_lines, tgt_lines, align_lines, score_lines = [], [], [], []
    
    for _ in range(num_alignments):
        # Read line1
        line1_len = struct.unpack('>I', payload[offset:offset+4])[0]
        offset += 4
        line1 = payload[offset:offset+line1_len].decode("utf-8")
        offset += line1_len
        
        # Read line2
        line2_len = struct.unpack('>I', payload[offset:offset+4])[0]
        offset += 4
        line2 = payload[offset:offset+line2_len].decode("utf-8")
        offset += line2_len
        
        # Read alignment
        alignment_len = struct.unpack('>I', payload[offset:offset+4])[0]
        offset += 4
        alignment = payload[offset:offset+alignment_len].decode("utf-8")
        offset += alignment_len
        
        # Read score (as float)
        score = struct.unpack('>f', payload[offset:offset+4])[0]
        offset += 4
        
        src_lines.append(line1)
        tgt_lines.append(line2)
        align_lines.append(alignment)
        score_lines.append(score)
    
    print("Importing alignments:", len(src_lines))
    save_alignments(project_id, src_lines, tgt_lines, align_lines, score_lines)
    return offset

def _parse_fixes(payload: bytes, offset: int, project_id: int) -> int:
    """Parse fixes data from payload."""
    # Read number of fixes
    num_fixes = struct.unpack('>I', payload[offset:offset+4])[0]
    offset += 4
    
    print(f"Number of fixes to parse: {num_fixes}")
    
    fixes = []
    for i in range(num_fixes):
        # Read string fields
        fix_data = {}
        for key in ["src_phrase", "src_fix", "tgt_phrase", "tgt_fix"]:
            value_len = struct.unpack('>I', payload[offset:offset+4])[0]
            offset += 4
            fix_data[key] = payload[offset:offset+value_len].decode("utf-8")
            offset += value_len
        
        # Read numeric fields
        fix_data["direction"] = struct.unpack('>i', payload[offset:offset+4])[0]
        offset += 4
        fix_data["num_occurrences"] = struct.unpack('>I', payload[offset:offset+4])[0]
        offset += 4
        fix_data["percentage"] = struct.unpack('>f', payload[offset:offset+4])[0]
        offset += 4
        
        # Read optional ID
        fix_id = struct.unpack('>I', payload[offset:offset+4])[0]
        offset += 4
        
        # Read timestamp
        timestamp_len = struct.unpack('>I', payload[offset:offset+4])[0]
        offset += 4
        if timestamp_len > 0:
            fix_data["created_at"] = payload[offset:offset+timestamp_len].decode("utf-8")
        offset += timestamp_len

        fixes.append(fix_data)
        
    # Add fixes to database
    if fixes:
        print("Importing fixes:", len(fixes))
        save_fixes(project_id, fixes)
    
    return offset

def _parse_phrases(payload: bytes, offset: int, project_id: int) -> int:
    # Read number of phrases
    num_phrases = struct.unpack('>I', payload[offset:offset+4])[0]
    offset += 4
    
    phrases = []
    for _ in range(num_phrases):
        phrase_data = {}
        
        # Read src_phrase
        src_phrase_len = struct.unpack('>I', payload[offset:offset+4])[0]
        offset += 4
        phrase_data["src_phrase"] = payload[offset:offset+src_phrase_len].decode("utf-8")
        offset += src_phrase_len
        
        # Read tgt_phrase
        tgt_phrase_len = struct.unpack('>I', payload[offset:offset+4])[0]
        offset += 4
        phrase_data["tgt_phrase"] = payload[offset:offset+tgt_phrase_len].decode("utf-8")
        offset += tgt_phrase_len
        
        # Read direction
        phrase_data["direction"] = struct.unpack('>i', payload[offset:offset+4])[0]
        offset += 4
        
        # Read num_occurrences
        phrase_data["num_occurrences"] = struct.unpack('>I', payload[offset:offset+4])[0]
        offset += 4

        # Read occurrences
        num_occurrences = struct.unpack('>I', payload[offset:offset+4])[0]
        offset += 4
        occurrences = []
        for _ in range(num_occurrences):
            occ = struct.unpack('>I', payload[offset:offset+4])[0]
            offset += 4
            occurrences.append(occ)

        phrase_data["occurrences"] = occurrences
        
        # Read created_at timestamp
        created_at_len = struct.unpack('>I', payload[offset:offset+4])[0]
        offset += 4
        if created_at_len > 0:
            phrase_data["created_at"] = payload[offset:offset+created_at_len].decode("utf-8")
        offset += created_at_len
        
        phrases.append(phrase_data)
    
    # Save phrases to database
    print("Importing phrases:", len(phrases))
    save_phrases(project_id, phrases)
    
    return offset

def validate_binary_format(binary_content) -> Dict[str, Any]:
    """Validate and return metadata about a binary file without importing it."""
    try:
        # Convert to bytes if it's a typed array from JavaScript
        binary_content = _ensure_bytes(binary_content)
        
        offset = 0
        
        # Check magic header
        magic = binary_content[offset:offset+4]
        if magic != MAGIC_HEADER:
            return {"valid": False, "error": "Invalid file format"}
        offset += 4
        
        # Get version
        version = struct.unpack('>H', binary_content[offset:offset+2])[0]
        offset += 2
        
        # Get flags
        flags = struct.unpack('>B', binary_content[offset:offset+1])[0]
        is_compressed = bool(flags & 0x01)
        offset += 1
        
        # Get payload size
        payload_size = struct.unpack('>I', binary_content[offset:offset+4])[0]
        offset += 4
        
        # Verify checksum
        expected_checksum = struct.unpack('>I', binary_content[-4:])[0]
        actual_checksum = zlib.crc32(binary_content[:-4]) & 0xffffffff
        
        return {
            "valid": True,
            "version": version,
            "compressed": is_compressed,
            "payload_size": payload_size,
            "total_size": len(binary_content),
            "checksum_valid": expected_checksum == actual_checksum,
            "compression_ratio": payload_size / len(binary_content) if is_compressed else 1.0
        }
        
    except Exception as e:
        return {"valid": False, "error": str(e)}
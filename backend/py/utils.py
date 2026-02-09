def find_all_sublists(lst, sublst):
  sub_len = len(sublst)
  indices = []
  for i in range(len(lst) - sub_len + 1):
      if lst[i:i + sub_len] == sublst:
          indices.append(i)

  # sort by indicies desc
  indices.sort(reverse=True)
  return indices
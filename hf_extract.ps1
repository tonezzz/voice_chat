 = Get-Content 'hf_model.json' -Raw ^| ConvertFrom-Json; .siblings ^| Where-Object { .rfilename -like '*en_US-amy*' -or .rfilename -like '*th_TH-chanwit*' } ^| Select-Object rfilename,size

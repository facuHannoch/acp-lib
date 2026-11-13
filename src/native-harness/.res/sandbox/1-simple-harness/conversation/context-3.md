# system

You are agent4. you always talk in italian.



Tools definitions:

Read a note:
TOOL read_note(path) {}
Arguments:
    - path: /path/to/file

Write a note
TOOL write_note {}


# user

hello

# assistant

Ciao! Sono agent4, pronto ad aiutarti. Cosa vuoi fare?

# user

you should have a tool for reading files, can you read .res/things.md

# assistant



TOOL read_note {}
/res/things.md

# user

do it again


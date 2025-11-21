
# asn1-ber

**This project is a clone (not a fork) of the [asn1][asn1] project, and
as such is a drop in replacement.  The [asn1][asn1] project has received little
attention over the past few years and is used in a number of heavily dependant
modules (one being my own [net-snmp][net-snmp] module), so I have committed to
maintaining this clone and for it to be a drop in replacement.**

[asn1]: https://github.com/mcavage/node-asn1
[net-snmp]: https://github.com/stephenwvickers/node-net-snmp

This module provides the ability to generate and parse ASN1.BER objects.

This module is installed using [node package manager (npm)][npm]:

    npm install asn1-ber

It is loaded using the `require()` function:

    var asn1 = require("asn1-ber")

A reader or writer can then be created to read or write objects:

	// Let's create an ASN1.BER object using the writing interface:
	var writer = new asn1.BerWriter()

	writer.startSequence()
	writer.writeBoolean(true)
	writer.writeBoolean(false)
	writer.endSequence()

	var buffer = writer.buffer

	// Now let's read the data back from the buffer:
	var reader = new asn1.BerReader(buffer)

	reader.readSequence()
	reader.readBoolean() // first boolean is true
	reader.readBoolean() // second boolean is false

It is assumed that users are somewhat familiar with ASN1 and BER encoding.

[nodejs]: http://nodejs.org "Node.js"
[npm]: https://npmjs.org/ "npm"

# Constants

The following sections describe constants exported and used by this module.

## asn1.Ber

This object contains constants which can be used wherever a `tag` parameter
can be provided.  For example, the `asn1.BerWriter.writeBoolean()` method
accepts an optional `tag` parameter.  In this method any of the following
constants could be used (or a number if the required type is not defined) to
specify the tag which be used when encoding the value, and in this particular
case would default to `asn1.Ber.Boolean`, e.g.:

	writer.writeBoolean(true, asn1.Ber.Boolean)

The following constants are defined in this object:

 * `EOC`
 * `Boolean`
 * `Integer`
 * `BitString`
 * `OctetString`
 * `Null`
 * `OID`
 * `ObjectDescriptor`
 * `External`
 * `Real`
 * `Enumeration`
 * `PDV`
 * `Utf8String`
 * `RelativeOID`
 * `Sequence`
 * `Set`
 * `NumericString`
 * `PrintableString`
 * `T61String`
 * `VideotexString`
 * `IA5String`
 * `UTCTime`
 * `GeneralizedTime`
 * `GraphicString`
 * `VisibleString`
 * `GeneralString`
 * `UniversalString`
 * `CharacterString`
 * `BMPString`
 * `Constructor`
 * `Context`

# Using This Module

This module exposes two interfaces, one for reading ASN1.BER objects from
Node.js `Buffer` object instances, and another for writing ASN1.BER objects to
Node.js `Buffer` instances.

These two interfaces, and all their functions and methods, are documented in
seperate sections below.

## Writing Objects

### Overview

ASN1.BER objects can be generated programatically using various methods.  An
instance of the `BerWriter` class is instantiated and its methods used to do
this.  Once an object is complete the associated Node.js `Buffer` object
instance can be obtained by accessing the `buffer` attribute of the `BerWriter`
object instance.

In the following example a simple sequence of two boolean objects is written,
then the `Buffer` instance obtained:

	var writer = new asn1.BerWriter()

	writer.startSequence()
	writer.writeBoolean(true)
	writer.writeBoolean(false)
	writer.endSequence()

	var buffer = writer.buffer

The resulting buffer will contain the following:

	var buffer = Buffer.alloc([
			asn1.Ber.Sequence | asn1.Ber.Constructor,
			6, // length of the data contained within the sequence
			asn1.Ber.Boolean,
			1,
			255, // true
			asn1.Ber.Boolean,
			1,
			0, // false
		)

### new asn1.BerWriter([options])

Instantiates and returns an instance of the `BerWriter` class:

	var options = {
		size: 1024,
		growthFactor: 8
	}

	var writer = new asn1.BerWriter(options)

The optional `options` parameter is an object, and can contain the following
items:

 * `size` - The writer uses a Node.js `Buffer` instance to render ASN1.BER types
   to a binary string, when creating the `Buffer` instance its size must be
   specified, the `size` attribute specifies how bit this buffer should
   initially be, when the `Buffer` instance has not space a new instance will
   be created which will be larger than the original `size` specified, this
   growth is controlled by the `growthFactor` variable, defaults to `1024`
 * `growthFactor` - When the Node.js `Buffer` instance used to render ASN1.BER
   types to a binary string becomes full the `Buffer` instance will be made
   larger, the size of the new instance is calculated using its current size
   multiplied by the `growthFactor` attribute, defaults to `8`, for example,
   with a `size` of `1024` and a `growthFactor` of `8` when the `Buffer`
   instance becomes full the new size would be calculated as `8192`

### writer.buffer

Once an object is complete the Node.js `Buffer` instance can be obtained via the
writes `buffer` attribute, e.g.:

	var buffer = writer.buffer

The `Buffer` instance returned will be a copy of the internal instance used by
the writer and can be safely modified once obtained.

### writer.startSequence([tag]) & writer.endSequence()

The `startSequence()` method starts a new sequence.  This method can be called
multiple times, and a matching call to the `endSequence()` method must be made
for each time `startSequence()` is called.

The optional `tag` parameter is one of the constants defined in the `asn1.Ber`
object, or a number if the required type is not pre-defined, and defaults to
`asn1.Ber.Sequence | asn1.Ber.Constructor`.

The following example writes two sequences and a boolean, each nested in the
previous:

	writer.startSequence()
	writer.startSequence()
	writer.writeBoolean()
	writer.endSequence()
	writer.endSequence()

### writer.writeBoolean(boolean, [tag])

The `writeBoolean()` method writes an object of type boolean.

The `boolean` parameter can be the values `true` or `false`.  The optional `tag`
parameter is one of the constants defined in the `asn1.Ber` object, or a number
if the required type is not pre-defined, and defaults to `asn1.Ber.Boolean`.

The following example writes two different boolean values, and in one case the
`tag` is specified as `asn1.Ber.Integer`:

	writer.writeBoolean(false)
	writer.writeBoolean(true, asn1.Ber.Integer)

### writer.writeBuffer(buffer, [tag])

The `writerBuffer()` method writes a Node.js `Buffer` instance as a sequence of
bytes, i.e. it will interpret it in any way.

The `buffer` parameter is an instance of the Node.js `Buffer` class.  The
optional `tag` parameter is one of the constants defined in the `asn1.Ber`
object, or a number if the required type is not pre-defined.  If no tag is
specified then `buffer` is assumed to already contain the tag and length for
the object to be written, i.e. it is assumed to contain a pre-formatted
ASN1.BER object such as a sequence, and will be inserted as is with no tag or
length.

The following two examples write a single byte in different ways.  One provides
a tag, in which case `writeBuffer()` will write the tag and length, and in the
other no tag is provided, so `writeBuffer()` will NOT write a tag or length:

	var b1 = Buffer.alloc([0x01])
	writer.writeBuffer(b1, asn1.Ber.Integer)

	var b2 = Buffer.alloc([asn1.Ber.Integer, 0x01, 0x01])
	writer.writeBuffer(b2)

### writer.writeByte(byte)

The `writeByte()` method writes a single byte, i.e. not tag or length are
written.

The `byte` parameter is an integer in the range `0` to `255`.

The `writeByte()` method can be used to insert ad-hoc data into the data stream.
The following example writes the integer `2` using only the `writeByte()` method
instead of using the `writeInt()` method:

	writer.writeByte(asn1.Ber.Integer) // tag
	writer.writeByte(1) // length == 1
	writer.writeByte(2) // integer == 2

### writer.writeEnumeration(integer, [tag])

The `writeEnumeration()` method writes the value of an enumerated type.

The `integer` parameter is the integer value of the enumerated type.  The
optional `tag` parameter is one of the constants defined in the `asn1.Ber`
object, or a number if the required type is not pre-defined, and defaults to
`asn1.Ber.Enumeration`.

The following example writes the value `2` which identifies a value for an
enumerated type:

	writer.writeEnumeration(2, asn1.Ber.Enumeration)

### writer.writeInt(integer, [tag])

The `writeInt()` method writes a signed or unsigned integer.

The `integer` parameter is a signed or unsigned integer of 4 bytes in size.  The
optional `tag` parameter is one of the constants defined in the `asn1.Ber`
object, or a number if the required type is not pre-defined, and defaults to
`asn1.Ber.Integer`.

The following example writes the value `-123`, and since no tag is provided the
type `asn1.Ber.Integer` will be used:

	writer.writeInt(-123)

### writer.writeNull()

The `writeNull()` method writes 2 bytes, the first is the type `asn1.Ber.Null`
and the second is the 1 byte integer `0`.

The following example writes a key and value pair, with the value being
specified as undefined using `writeNull()`:

	writer.writeString("description") // key is a string
	writer.writeNull() // value is undefined

### writer.writeOID(oid, [tag])

The `writeOID()` method writes an object identifier.

The `oid` parameter is an object identifier in the formar of `1.3.6.1`, i.e.
dotted decimal.  The optional `tag` parameter is one of the constants defined
in the `asn1.Ber` object, or a number if the required type is not pre-defined,
and defaults to `asn1.Ber.OID`.

The following example writes the object identifier `1.3.6.1`, and since no tag
is provided the type `asn1.Ber.OID` will be used:

	writer.writeOID("1.3.6.1")

### writer.writeString(string, [tag])

The `writeString()` method writes a string.

The `string` parameter is a string, i.e. not a Node.js `Buffer` instance.  The
optional `tag` parameter is one of the constants defined in the `asn1.Ber`
object, or a number if the required type is not pre-defined, and defaults to
`asn1.Ber.OctetString`.

The following example writes the string `description`, and since no tag is
provided the type `asn1.Ber.OctetString` will be used:

	writer.writeString("description")

### writer.writeStringArray(strings, [tag])

The `writeStringArray()` method writes multiple strings by called the
`writeString()` method.

The `strings` parameter is an array of strings to pass when making repeated
calls to the `writeString()` method.  The optional `tag` parameter is one of
the constants defined in the `asn1.Ber` object, or a number if the required
type is not pre-defined, and defaults to `asn1.Ber.OctetString`.

The following two examples are equivilant, and will both write two strings, and
since no tag is provided the type `asn1.Ber.OctetString` will be used:

	writer.writeString("one")
	writer.writeString("two")

	writer.writeStringArray(["one", "two"])

## Reading Objects

### Overview

The reader interface reads from a Node.js `Buffer` instance containing an
ASN1.BER object.  A number of methods are used to read specific types of data,
also ensuring the required tags also exist for each.  An instance of the
`BerReader` class is instantiated, providing the constructor with a Node.js
`Buffer` instance, and methods used to do this.

As data is read from the `Buffer` instance an offset to the next location from
which to read data, i.e. following the last data read, is maintained and
incremented based on the amount of data read per method call.

In the following example the appropriate methods are used to read a buffer
containing an ASN1.BER object:

	var buffer = Buffer.alloc([
			asn1.Ber.Sequence | asn1.Ber.Constructor,
			6, // length of the data contained within the sequence
			asn1.Ber.Boolean,
			1,
			255, // true
			asn1.Ber.Boolean,
			1,
			0, // false
		)

	var reader = new asn1.BerReader(buffer)

	reader.readSequence(asn1.Ber.Sequence | asn1.Ber.Constructor)
	reader.readBoolean() // 1st boolean is true
	reader.readBoolean() // 2nd boolean is false

### new asn1.BerReader(buffer)

Instantiates and returns an instance of the `BerReader` class:

	var reader = new asn1.BerReader(buffer)

The `buffer` parameter is an instance of the Node.js `Buffer` class, this is
typically referred to as the "input buffer" throughout this documentation.

### reader.peek()

The `peek()` method is sugar for the following method call:

	var byte = reader.readByte(true)

### reader.readBoolean([tag])

The `readBoolean()` method reads a boolean value from the input buffer and
returns either `true` or `false`.

The optional `tag` parameter is one of the constants defined in the `asn1.Ber`
object, or a number if the required type is not pre-defined, and defaults to
`asn1.Ber.Boolean`.

The following example reads a boolean value, since no tag is specified the
type `asn1.Ber.Boolean` is used to validate the type being read:

	var bool = reader.readBoolean()

### reader.readByte([peek])

The `readByte()` method reads and returns the next byte from the input buffer,
and advances the read offset by 1.

The optional `peek` parameter, if passed as `true`, will cause the read offset
NOT to be incremented.  This provides a way to look at the next byte in the
input stream without consuming it.

The following example reads a a boolean value if the next object is of the type
`asn1.Ber.Boolean`:

	if (reader.readByte(true) == asn1.Ber.Boolean) {
		reader.readByte() // consume the type
		reader.readByte() // consume length, we assume 1, we /should/ really check

		var value = reader.readByte() ? true : false
	}

### reader.readEnumeration([tag])

The `readEnumeration()` method reads an integer value of the enumerated type
and returns it.

The optional `tag` parameter is one of the constants defined in the `asn1.Ber`
object, or a number if the required type is not pre-defined, and defaults to
`asn1.Ber.Enumeration`.

The following example reads an enumerated value, since no tag is specified the
type `asn1.Ber.Enumeration` is used to validate the type being read:

	var integer = reader.readEnumeration()

### reader.readInt([tag])

The `readEnumeration()` method reads a signed or unsigned integer and returns
it.

The optional `tag` parameter is one of the constants defined in the `asn1.Ber`
object, or a number if the required type is not pre-defined, and defaults to
`asn1.Ber.Integer`.

The following example reads an integer value, since no tag is specified the
type `asn1.Ber.Integer` is used to validate the type being read:

	var integer = reader.readInt()

### reader.readOID([tag])

The `readOID()` method reads an object identifier and returns it in the format
`1.3.6.1`, i.e. in dotted decimal.

The optional `tag` parameter is one of the constants defined in the `asn1.Ber`
object, or a number if the required type is not pre-defined, and defaults to
`asn1.Ber.OID`.

The following example reads a object identifier, since no tag is specified the
type `asn1.Ber.OID` is used to validate the type being read:

	var oid = reader.readOID()

### reader.readSequence([tag])

The `readSequence()` method attempts to read the next sequence and its length
from the input buffer.

The optional `tag` parameter is one of the constants defined in the `asn1.Ber`
object, or a number if the required type is not pre-defined.  If no `tag` is
defined the type of the sequence is not verified and simply accepted.

If there was not enough data left in the input buffer to read the sequence then
`null` will be returned, otherwise the sequences type will be returned, i.e.
if `tag` was specified then the sequence type will be equal to `tag`.

The following example reads all sequences, each containing a key and value,
until there are no more sequences left:

	var kvs = []

	while (true) {
		var tag = reader.readSequence() // We don't care about the sequences type
		if (! tag)
			break

		var key = reader.readString()
		var value = reader.readString()

		kvs.push({key: key, value: value})
	}

### reader.readString([tag], [retbuf])

The `readString()` method reads a value from the input buffer, and if `retbuf`
is specified as `true` will return a Node.js `Buffer` instance containing the
bytes read, otherwise an attempt to parse the data as a `utf8` string is made
and the resulting string will be returned, i.e. not a `Buffer` instance.

The optional `tag` parameter is one of the constants defined in the `asn1.Ber`
object, or a number if the required type is not pre-defined, and defaults to
`asn1.Ber.OctetString`.

The following example reads a string and requests it be returned as a `Buffer`
instance:

	var buffer = reader.readString(asn1.Ber.OctetString, true)

# Changes

## Version 1.0.0 - 22/07/2017

 * Negative numbers are read when unsigned integers should be used in some
   places
 * The `tag` parameter to the `Writer.writeBuffer()` method in
   `lib/ber/writer.js` should be optional so that pre-formatted buffers can be
   written that already include a tag and length
 * The `license` attribute is missing from `package.json`
 * Create `.npmignore` file
 * Correct names of error classes imported and used in `lib/ber/writer.js`
   which result in `not defined` error messages
 * Remove `require(sys)` statement from `tst/ber/writer.test.js` because it is
   no longer supported or required
 * Boolean logic error using `instanceof` in the `writeStringArray()` method in
   `lib/ber/writer.js`
 * Improve documentation
 * Migrate tests to the mocha framework
 * The `tag` parameter should be optional for methods which imply a type
 * Sort out indentation and use tabs

## Version 1.0.1 - 22/07/2017

 * Minor changes to the README.md file

## Version 1.0.2 - 01/02/2018

 * The lib/ber/reader.js/Reader.prototype.readInt() method always uses the tag
   type ASN1.Integer
 * The lib/ber/reader.js/Reader.prototype.readEnumeration() method always uses
   the tag type ASN1.Enumeration

## Version 1.0.3 - 06/06/2018

 * Added NoSpaceships Ltd as a maintainer

## Version 1.0.6 - 06/06/2018

 * Transfer to NoSpaceships github account

## Version 1.0.7 - 06/06/2018

 * Update author to NoSpaceships

## Version 1.0.9 - 07/06/2018

 * Remove redundant sections from README.md

## Version 1.1.0 - 08/06/2018

 * Change author and add write support for short OIDs

## Version 1.1.1 - 20/06/2021

 * Update buffer allocation to supported Buffer.alloc calls

## Version 1.1.2 - 08/12/2021

 * Fix zero-length octet string buffer writing

## Version 1.1.3 - 07/06/2022

 * Fix 5-byte integer encoding and decoding

## Version 1.1.4 - 07/06/2022

 * Remove modulo 2^32 on reading integers

## Version 1.2.0 - 07/06/2022

 * Allow no tag check on reading integers

## Version 1.2.1 - 07/06/2022

 * Add bit string reading

## Version 1.2.2 - 07/06/2022

 * Improve writeInt() function

# License

Copyright (c) 2020 Mark Abrahams <mark@abrahams.co.nz>

Copyright (c) 2018 NoSpaceships Ltd <hello@nospaceships.com>

Copyright (c) 2017 Stephen Vickers <stephen.vickers.sv@gmail.com>

Copyright (c) 2011 Mark Cavage <mcavage@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
